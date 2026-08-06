# Margo Device Programmer — Web Firmware Updater

A browser-based firmware updater for Margo hardware. The customer opens one web
page, picks the **product** they're updating, plugs it in, chooses a firmware,
and clicks a button. Nothing is installed and no PowerShell is run — every update
happens over the Web Serial API, entirely in the browser.

## Products

| Product | Board | How it flashes |
|---------|-------|----------------|
| **Programmer Stick** | Adafruit Feather nRF52840 | Nordic legacy serial DFU (`dfu.js`) |
| **Avian Alarm** *(formerly Squawk Box)* | Arduino MKR Zero (SAMD21) | Arduino SAM-BA / BOSSA protocol (`bossa.js`) |

Adding the Avian Alarm replaces its old `SquawkBoxLoader` bundle
(`arduino-cli.exe` + PowerShell). Same firmware, no download.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | The page the customer opens — product picker + flashing flow. |
| `dfu.js` | nRF52 legacy serial DFU (Adafruit nrfutil 0.5.x), ported to Web Serial. |
| `bossa.js` | Arduino SAMD21 SAM-BA / BOSSA flasher, ported to Web Serial. |
| `catalog.json` | The product + firmware menu. **Generated — don't edit by hand.** |
| `firmware/**` | The firmware images. **Generated.** |
| `make_catalog.py` | Builds `catalog.json` + `firmware/` from the sources in `packages/`. |
| `packages/**` | Source firmware (DFU `.zip`s for the stick, raw `.bin`s for the Avian Alarm). |

## Requirements for the customer

- **Google Chrome or Microsoft Edge** on a desktop/laptop. Web Serial is not
  supported in Safari, Firefox, or on phones/tablets.
- The page must be served over **HTTPS** (GitHub Pages does this for you).

## Changing the firmware menu

Everything about the menu lives in the `PRODUCTS` list at the top of
`make_catalog.py`. Each product has a `method` (`nrf-dfu` or `samd-bossa`) and a
list of firmwares.

- **nrf-dfu** firmwares point at a DFU `.zip` in `packages/` (app `.bin` + `.dat`
  init packet). The build checks the image CRC against the init packet.
- **samd-bossa** firmwares list one or more `stages`, each a raw application
  `.bin` in `packages/`. A `wipe` stage (with `runMs`) runs before the main app,
  mirroring the old two-step SquawkBoxLoader. Images are written at
  `flashOffset` (0x2000 — the 8 KB bootloader is preserved).

To rebuild after changing sources or the list:

```bash
python3 make_catalog.py
```

Then commit the regenerated `catalog.json` and `firmware/` folder and push.
Each product must have exactly one firmware with `default: True`.

## How each flow works

**Programmer Stick (nRF DFU).** Start update → pick the stick → the page sends a
1200-baud "touch" that resets it into the Adafruit DFU bootloader → it reconnects
as a new USB device, so the browser asks you to pick it again → the page verifies
the image CRC16 and runs the DFU sequence (start, erase, init packet, 512-byte
data packets, stop).

**Avian Alarm (SAMD BOSSA).** For each stage: pick the device → the page sends a
1200-baud touch that resets the MKR Zero into its Arduino SAM-BA bootloader → pick
it again → the page runs the exact bossac sequence: `N`/`V` handshake, chip-erase
from 0x2000 (`X`, so the bootloader survives), stage each 4 KB block into SRAM
(`S`) and commit it to flash (`Y`), verify every block with the bootloader's CRC16
(`Z`), then reset (`K`). The "with memory clear" firmware flashes the wipe sketch
first, lets it run, then repeats for the main firmware.

`bossa.js` was written directly against Arduino's BOSSA 1.9.1 sources
(`Samba.cpp`, `D2xNvmFlash.cpp`, `Flasher.cpp`, `Device.cpp`). The protocol layer
is covered by an offline test against a mock SAM-BA bootloader, but the **first
flash of a real Avian Alarm should be watched via the on-page Technical log** to
confirm end-to-end behavior on hardware.

## Local testing

Web Serial needs a secure context, so `file://` won't work. Serve locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000  (localhost counts as secure)
```
