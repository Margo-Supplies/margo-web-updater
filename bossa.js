// Arduino SAM-BA / BOSSA flasher for the Avian Alarm (Arduino MKR Zero, SAMD21),
// ported to the Web Serial API. The command set and flash sequence below follow
// Arduino's BOSSA (bossac) exactly for the SAMD21 "D2x" NVM path:
//
//   * N#              set binary mode
//   * V#              version string  ->  "...[Arduino:IKXYZ]..."
//   * w<addr>,4#      read a 32-bit word (little-endian)
//   * W<addr>,<val>#  write a 32-bit word
//   * X<offset>#      chip-erase the flash from <offset> to the end
//                     (offset must be non-zero so the 8 KB bootloader survives)
//   * S<addr>,<size>#<binary>   stage <size> bytes into SRAM at <addr>
//   * Y<src>,0#  then  Y<dst>,<size>#   copy staged SRAM -> flash (NVM write)
//   * Z<addr>,<size>#   CRC16 (CCITT/XMODEM) of a flash region, for verify
//   * K#              reset the CPU
//
// Device: ATSAMD21x18 (MKR Zero) — 64-byte pages, 4096 pages (256 KB),
// application at flash offset 0x2000, SRAM work area at 0x20004000.
//
// This module was written against the Arduino BOSSA 1.9.1 sources
// (Samba.cpp / D2xNvmFlash.cpp / Flasher.cpp / Device.cpp). It has NOT yet been
// validated end-to-end against a physical board from this environment, so the
// first real flash should be watched via the on-page technical log.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex8 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, "0");

// ---- CRC16-CCITT / XMODEM table (identical to BOSSA Samba::crc16Table) -------
// Used by the bootloader's 'Z' checksum command; we recompute it locally to
// verify each region we wrote.
const CRC16_TAB = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 8) & 0xffff;
    for (let k = 0; k < 8; k++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    t[i] = c;
  }
  return t;
})();

function crc16(data, crc = 0) {
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC16_TAB[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

// ---- Web Serial transport ----------------------------------------------------
class Link {
  constructor(port) {
    this.port = port;
    this.rx = [];
    this._closed = false;
  }
  async open(baudRate = 115200) {
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._loop = this._readLoop();
  }
  async _readLoop() {
    try {
      while (!this._closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) for (const b of value) this.rx.push(b);
      }
    } catch (_) {
      /* reader cancelled on close */
    }
  }
  clear() {
    this.rx.length = 0;
  }
  async writeBytes(u8) {
    await this.writer.write(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
  }
  async writeStr(s) {
    await this.writeBytes(new TextEncoder().encode(s));
  }
  // Wait until exactly n bytes are available, or throw on timeout.
  async read(n, timeoutMs) {
    const start = Date.now();
    while (this.rx.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("The device stopped responding. Unplug it, plug it back in, and start over.");
      }
      await sleep(4);
    }
    return this.rx.splice(0, n);
  }
  // Collect whatever arrives within ms (for variable-length replies like V#).
  async drain(ms) {
    await sleep(ms);
    return this.rx.splice(0, this.rx.length);
  }
  async close() {
    this._closed = true;
    try { await this.reader.cancel(); } catch (_) {}
    try { this.reader.releaseLock(); } catch (_) {}
    try { await this.writer.close(); } catch (_) {}
    try { this.writer.releaseLock(); } catch (_) {}
    try { await this.port.close(); } catch (_) {}
  }
}

const ascii = (bytes) => bytes.map((b) => String.fromCharCode(b)).join("");

// ---- SAM-BA commands ---------------------------------------------------------
async function setBinaryMode(link) {
  link.clear();
  await link.writeStr("N#");
  // Bootloader replies "\n\r"; tolerate a slow/absent reply.
  try { await link.read(2, 400); } catch (_) {}
}

async function version(link) {
  link.clear();
  await link.writeStr("V#");
  const bytes = await link.drain(300);
  let s = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else if (s.length) break;
  }
  return s.trim();
}

function parseCaps(ver) {
  const caps = { I: false, K: false, X: false, Y: false, Z: false };
  const m = ver.match(/\[Arduino:([A-Z]+)\]/);
  if (m) for (const ch of m[1]) if (ch in caps) caps[ch] = true;
  return caps;
}

async function readWord(link, addr) {
  link.clear();
  await link.writeStr(`w${hex8(addr)},4#`);
  const b = await link.read(4, 1000);
  return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
}

async function writeWord(link, addr, val) {
  await link.writeStr(`W${hex8(addr)},${hex8(val)}#`);
}

async function chipErase(link, offset) {
  link.clear();
  await link.writeStr(`X${hex8(offset)}#`);
  const b = await link.read(3, 30000); // erasing the app area takes a moment
  if (b[0] !== 0x58 /* 'X' */) throw new Error("Erase command was not acknowledged by the device.");
}

async function stageToSram(link, addr, data) {
  await link.writeStr(`S${hex8(addr)},${hex8(data.length)}#`);
  // The SAM-BA USB firmware corrupts data if the command and the binary land in
  // the same USB packet, so separate them (BOSSA flushes here for the same reason).
  await sleep(3);
  await link.writeBytes(data);
  await sleep(2);
}

async function copyToFlash(link, srcAddr, dstAddr, size) {
  link.clear();
  await link.writeStr(`Y${hex8(srcAddr)},0#`);
  let b = await link.read(3, 3000);
  if (b[0] !== 0x59 /* 'Y' */) throw new Error("Write command (stage) was not acknowledged.");
  link.clear();
  await link.writeStr(`Y${hex8(dstAddr)},${hex8(size)}#`);
  b = await link.read(3, 15000);
  if (b[0] !== 0x59 /* 'Y' */) throw new Error("Write command (commit) was not acknowledged.");
}

async function checksumFlash(link, addr, size) {
  link.clear();
  await link.writeStr(`Z${hex8(addr)},${hex8(size)}#`);
  const b = await link.read(12, 15000); // "Z00000000#\n\r"
  if (b[0] !== 0x5a /* 'Z' */) throw new Error("Verify command was not acknowledged.");
  return parseInt(ascii(b.slice(1, 9)), 16) & 0xffff;
}

async function resetDevice(link, caps) {
  // The device resets immediately, so the reply/port usually just drops — ignore.
  try {
    if (caps.K) await link.writeStr("K#");
    else await writeWord(link, 0xe000ed0c, 0x05fa0004); // Cortex-M SYSRESETREQ
  } catch (_) {}
}

// Known SAMD21x18 (G18/J18/E18) device IDs, masked as BOSSA does (& 0xffff00ff).
const SAMD21X18_IDS = new Set([0x10010000, 0x10010005, 0x1001000a, 0x1001000f]);

// ---- public: flash one raw application image at `offset` ---------------------
// image: Uint8Array (the .bin). opts: { offset, verify, hooks:{onProgress,onStatus,onLog} }
async function flashSamdImage(port, image, opts = {}) {
  const offset = opts.offset ?? 0x2000;
  const verify = opts.verify !== false;
  const h = opts.hooks || {};
  const onProgress = (f) => h.onProgress && h.onProgress(Math.max(0, Math.min(1, f)));
  const onStatus = (s) => h.onStatus && h.onStatus(s);
  const onLog = (m) => h.onLog && h.onLog(m);

  const CHUNK = 4096; // matches BOSSA writeBufferSize()
  const STAGING = 0x20004000; // SRAM work area for ATSAMD21x18
  const PAGE = 64;

  const padToPage = (u8) => {
    if (u8.length % PAGE === 0) return u8;
    const out = new Uint8Array(Math.ceil(u8.length / PAGE) * PAGE);
    out.set(u8);
    return out; // padding bytes are 0x00, exactly like BOSSA
  };

  const link = new Link(port);
  await link.open(115200);
  try {
    await link.drain(60); // flush any boot chatter
    onStatus("Connecting");
    await setBinaryMode(link);
    const ver = await version(link);
    onLog(`Bootloader: ${ver || "(no version string)"}`);
    const caps = parseCaps(ver);
    if (!/\[Arduino:/.test(ver)) {
      throw new Error("This device isn't in the Arduino update-mode bootloader. Start over so it can switch into update mode.");
    }
    if (!caps.X || !caps.Y) {
      throw new Error("This bootloader is missing the fast, safe write commands this updater needs.");
    }

    // Sanity-check the chip so we never program the wrong board.
    try {
      const cpuid = (await readWord(link, 0xe000ed00)) & 0x0000fff0;
      const did = await readWord(link, 0x41002018);
      const fam = (did & 0xffff00ff) >>> 0;
      onLog(`CPUID=0x${cpuid.toString(16)}  DID=0x${(did >>> 0).toString(16)}`);
      if (cpuid !== 0x0000c600) onLog("Note: CPU doesn't look like a Cortex-M0+ — proceeding anyway.");
      else if (!SAMD21X18_IDS.has(fam)) onLog(`Note: unexpected SAMD21 variant (0x${fam.toString(16)}) — proceeding anyway.`);
    } catch (e) {
      onLog("Chip-ID check skipped: " + (e.message || e));
    }

    onStatus("Erasing");
    onLog(`Erasing application flash from 0x${offset.toString(16)}…`);
    await chipErase(link, offset);

    onStatus("Writing firmware");
    onLog(`Writing ${image.length.toLocaleString()} bytes at 0x${offset.toString(16)}…`);
    for (let off = 0; off < image.length; off += CHUNK) {
      const raw = image.subarray(off, Math.min(off + CHUNK, image.length));
      const buf = padToPage(raw);
      await stageToSram(link, STAGING, buf);
      await copyToFlash(link, STAGING, offset + off, buf.length);
      onProgress(((off + raw.length) / image.length) * (verify ? 0.9 : 1));
    }

    if (verify) {
      onStatus("Verifying");
      onLog("Verifying flash contents…");
      for (let off = 0; off < image.length; off += CHUNK) {
        const raw = image.subarray(off, Math.min(off + CHUNK, image.length));
        const buf = padToPage(raw);
        const want = crc16(buf);
        const got = await checksumFlash(link, offset + off, buf.length);
        if (want !== got) {
          throw new Error(
            `Verification failed near 0x${(offset + off).toString(16)} ` +
            `(device 0x${got.toString(16)} vs file 0x${want.toString(16)}). The update did not complete correctly — please try again.`
          );
        }
        onProgress(0.9 + ((off + raw.length) / image.length) * 0.1);
      }
      onLog("Verify OK — flash matches the firmware.");
    }

    onStatus("Restarting");
    onLog("Restarting the device…");
    await resetDevice(link, caps);
    await sleep(300);
    onProgress(1);
  } finally {
    await link.close();
  }
}

// 1200-baud "touch" that resets an Arduino SAMD (MKR/Zero) board out of the
// running sketch and into its SAM-BA bootloader — the same trick arduino-cli
// uses. bossac drives it as RTS=1, DTR=0 then closes.
async function touchSamd1200(port) {
  await port.open({ baudRate: 1200 });
  try { await port.setSignals({ dataTerminalReady: false, requestToSend: true }); } catch (_) {}
  await sleep(120);
  await port.close();
}

export { flashSamdImage, touchSamd1200, crc16 };
