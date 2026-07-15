// Adafruit nRF52 legacy serial DFU (nrfutil 0.5.x protocol), ported to the
// Web Serial API. The packet builder below was verified byte-for-byte against
// Adafruit's original Python (dfu_transport_serial.py) for START/INIT/DATA/STOP.

const DIP = 1;            // data integrity check present
const RP = 1;             // reliable packet
const HCI = 14;           // HCI packet type

const DFU_INIT = 1;
const DFU_START = 3;
const DFU_DATA = 4;
const DFU_STOP = 5;

const MODE_APPLICATION = 4;

const DFU_PACKET_MAX_SIZE = 512;
const FLASH_PAGE_SIZE = 4096;
const FLASH_PAGE_ERASE_TIME = 0.0897;                     // seconds / page
const FLASH_PAGE_WRITE_TIME = (FLASH_PAGE_SIZE / 4) * 0.0001; // 0.1024 s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CRC16 (matches nordicsemi/dfu/crc16.py exactly) ----
function calcCrc16(data, crc = 0xffff) {
  for (const b of data) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= b;
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
  }
  return crc & 0xffff;
}

function slipHeader(seq, pktLen) {
  const i0 = seq | (((seq + 1) % 8) << 3) | (DIP << 6) | (RP << 7);
  const i1 = HCI | ((pktLen & 0x000f) << 4);
  const i2 = (pktLen & 0x0ff0) >> 4;
  const i3 = (~(i0 + i1 + i2) + 1) & 0xff;
  return [i0 & 0xff, i1 & 0xff, i2 & 0xff, i3];
}

function slipEncodeEsc(bytes) {
  const out = [];
  for (const c of bytes) {
    if (c === 0xc0) out.push(0xdb, 0xdc);
    else if (c === 0xdb) out.push(0xdb, 0xdd);
    else out.push(c);
  }
  return out;
}

const int32le = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const int16le = (v) => [v & 0xff, (v >> 8) & 0xff];

// Stateful HCI packet builder — sequence number increments per packet.
class HciBuilder {
  constructor() {
    this.seq = 0;
  }
  reset() {
    this.seq = 0;
  }
  build(data) {
    this.seq = (this.seq + 1) % 8;
    let tmp = slipHeader(this.seq, data.length).concat(data);
    const crc = calcCrc16(tmp, 0xffff);
    tmp = tmp.concat([crc & 0xff, (crc & 0xff00) >> 8]);
    const enc = slipEncodeEsc(tmp);
    return new Uint8Array([0xc0, ...enc, 0xc0]);
  }
}

// ---- Web Serial transport ----
class SerialLink {
  constructor(port) {
    this.port = port;
    this.writer = null;
    this.reader = null;
    this.rxBuf = [];
    this._readLoopPromise = null;
    this._closed = false;
  }

  async open() {
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._readLoopPromise = this._readLoop();
  }

  async _readLoop() {
    try {
      while (!this._closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) for (const b of value) this.rxBuf.push(b);
      }
    } catch (_) {
      /* reader cancelled on close */
    }
  }

  async write(u8) {
    await this.writer.write(u8);
  }

  // Consume one SLIP frame (delimited by two 0xC0 bytes), like nrfutil's
  // get_ack_nr. Returns true on ack, false on timeout.
  async readAck(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let c0 = 0;
      let secondIdx = -1;
      for (let i = 0; i < this.rxBuf.length; i++) {
        if (this.rxBuf[i] === 0xc0) {
          c0++;
          if (c0 >= 2) {
            secondIdx = i;
            break;
          }
        }
      }
      if (secondIdx >= 0) {
        this.rxBuf.splice(0, secondIdx + 1); // drop through the 2nd 0xC0
        return true;
      }
      await sleep(4);
    }
    return false;
  }

  async close() {
    this._closed = true;
    try {
      await this.reader.cancel();
    } catch (_) {}
    try {
      this.reader.releaseLock();
    } catch (_) {}
    try {
      await this.writer.close();
    } catch (_) {}
    try {
      this.writer.releaseLock();
    } catch (_) {}
    try {
      await this.port.close();
    } catch (_) {}
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Run a full application DFU. `firmwareBin`/`initPacket` are Uint8Arrays.
// `hooks`: { onProgress(fraction), onStatus(text), onLog(text) }
async function runDfu(port, firmwareBin, initPacket, hooks = {}) {
  const log = (m) => hooks.onLog && hooks.onLog(m);
  const status = (s) => hooks.onStatus && hooks.onStatus(s);
  const progress = (f) => hooks.onProgress && hooks.onProgress(f);

  const link = new SerialLink(port);
  const b = new HciBuilder();
  b.reset();

  await link.open();
  await sleep(100); // SERIAL_PORT_OPEN_WAIT_TIME

  const appSize = firmwareBin.length;
  const totalSize = appSize;

  // 1) START
  log("Sending start command…");
  status("Preparing device");
  let frame = [
    ...int32le(DFU_START),
    ...int32le(MODE_APPLICATION),
    ...int32le(0),
    ...int32le(0),
    ...int32le(appSize),
  ];
  await link.write(b.build(frame));
  await link.readAck(2000);

  // Device erases flash after start; wait accordingly.
  const eraseWaitMs = Math.max(500, (Math.floor(totalSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME * 1000);
  log(`Erasing flash (~${(eraseWaitMs / 1000).toFixed(1)}s)…`);
  await sleep(eraseWaitMs);

  // 2) INIT packet (from the .dat file) + 2-byte padding
  log("Sending init packet…");
  frame = [...int32le(DFU_INIT), ...initPacket, ...int16le(0x0000)];
  await link.write(b.build(frame));
  await link.readAck(2000);

  // 3) Firmware image in 512-byte data packets
  status("Writing firmware");
  log(`Writing ${appSize.toLocaleString()} bytes…`);
  const chunks = Math.ceil(appSize / DFU_PACKET_MAX_SIZE);
  let misses = 0;
  for (let i = 0, idx = 0; i < appSize; i += DFU_PACKET_MAX_SIZE, idx++) {
    const slice = firmwareBin.subarray(i, i + DFU_PACKET_MAX_SIZE);
    frame = [...int32le(DFU_DATA), ...slice];
    await link.write(b.build(frame));
    const acked = await link.readAck(3000);
    if (!acked) {
      misses++;
      if (misses > 5) {
        await link.close();
        throw new Error("The device stopped responding during the update. Unplug it, plug it back in, put it in update mode, and try again.");
      }
    } else {
      misses = 0;
    }
    // Every 8th frame (~4 KB) the chip erases/writes a page and blocks; pause.
    if (idx % 8 === 0) await sleep(FLASH_PAGE_WRITE_TIME * 1000);
    progress(Math.min(1, (idx + 1) / chunks));
  }

  await sleep(FLASH_PAGE_WRITE_TIME * 1000);

  // 4) STOP
  log("Finishing…");
  frame = int32le(DFU_STOP);
  await link.write(b.build(frame));
  await link.readAck(2000);

  progress(1);
  status("Activating");

  await link.close();

  // Give the bootloader time to activate the image and reboot before we
  // tell the user it's safe to unplug.
  const activateMs =
    (Math.max(500, (Math.floor(totalSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME * 1000)) +
    ((Math.floor(totalSize / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_WRITE_TIME * 1000);
  log(`Activating new firmware (~${(activateMs / 1000).toFixed(1)}s)…`);
  await sleep(activateMs);
}

// Open a port briefly at 1200 baud to reset the board into update mode.
async function touch1200(port) {
  await port.open({ baudRate: 1200 });
  await sleep(120);
  try {
    await port.setSignals({ dataTerminalReady: false });
  } catch (_) {}
  await sleep(120);
  await port.close();
}

export { runDfu, touch1200, b64ToBytes };
