# Margo Programmer Stick — Web Firmware Updater

A browser-based firmware updater for the Margo Programmer Stick (Adafruit
Feather nRF52840). The customer opens a web page, plugs in the stick, puts it in
update mode, and clicks one button. Nothing is installed and no PowerShell is
run — the update happens over the Web Serial API, entirely in the browser.

This replaces the old `MargoProgrammerUpdate.ps1` + `arduino-cli.exe` bundle.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page the customer opens. |
| `dfu.js` | The nRF52 serial DFU protocol (Adafruit nrfutil 0.5.x), ported to Web Serial. |
| `firmware.js` | The embedded firmware (`.bin` + `.dat`), base64-encoded. **Regenerate this to ship new firmware.** |
| `make_firmware_js.py` | Turns a DFU `.zip` into `firmware.js`. |

## Requirements for the customer

- **Google Chrome or Microsoft Edge** on a desktop/laptop. Web Serial is not
  supported in Safari, Firefox, or on phones/tablets.
- The page must be served over **HTTPS** (GitHub Pages does this for you).

## Publishing new firmware

When you have a new DFU package (the `.zip` with `manifest.json`, `*.bin`,
`*.dat`):

```bash
python3 make_firmware_js.py MargoProgrammerStick.zip firmware.js
```

Commit the updated `firmware.js` and push. That's the whole release.

## How it works

The stick runs Adafruit's nRF52 bootloader, which accepts firmware over a simple
serial (CDC) link using Nordic's legacy DFU protocol. `dfu.js` speaks that
protocol directly from the browser:

1. Open the port at 115200 baud.
2. Send the **start** packet (application mode + image size), wait for flash erase.
3. Send the **init** packet (the `.dat` file).
4. Stream the firmware in 512-byte **data** packets, pausing every ~4 KB for the
   flash page write.
5. Send the **stop** packet; the bootloader activates the image and reboots.

The packet builder (SLIP framing, CRC16, sequence numbering) was verified
byte-for-byte against Adafruit's original Python `dfu_transport_serial.py`.

## Local testing

Web Serial needs a secure context, so `file://` won't work. Serve locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000  (localhost counts as secure)
```
