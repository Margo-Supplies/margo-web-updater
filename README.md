# Margo Programmer Stick — Web Firmware Updater

A browser-based firmware updater for the Margo Programmer Stick (Adafruit
Feather nRF52840). The customer opens a web page, plugs in the stick, picks a
firmware from the menu, and clicks one button. Nothing is installed and no
PowerShell is run — the update happens over the Web Serial API, entirely in the
browser.

This replaces the old `MargoProgrammerUpdate.ps1` + `arduino-cli.exe` bundle.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | The page the customer opens. |
| `dfu.js` | The nRF52 serial DFU protocol (Adafruit nrfutil 0.5.x), ported to Web Serial. |
| `catalog.json` | The firmware menu. **Generated — don't edit by hand.** |
| `firmware/<id>/app.bin`, `app.dat` | The firmware images. **Generated.** |
| `make_catalog.py` | Builds `catalog.json` + `firmware/` from DFU `.zip` packages. |
| `packages/*.zip` | Your source DFU packages (inputs to the generator). |

## Requirements for the customer

- **Google Chrome or Microsoft Edge** on a desktop/laptop. Web Serial is not
  supported in Safari, Firefox, or on phones/tablets.
- The page must be served over **HTTPS** (GitHub Pages does this for you).

## Changing the firmware menu

Everything about the menu lives in the `SOURCES` list at the top of
`make_catalog.py`:

```python
SOURCES = [
    {
        "id": "stick",                              # folder name + internal id
        "label": "Programmer Stick (recommended)",  # what the customer sees
        "note": "The standard firmware for customer programmer sticks.",
        "zip": "packages/MargoProgrammerStick.zip",
        "default": True,                            # preselected on page load
        "warn": False,                              # True = amber caution style
    },
    ...
]
```

To **add an option**: drop the DFU `.zip` in `packages/`, add an entry, re-run.
To **update an option**: replace the `.zip` (same filename) and re-run.
To **remove one**: delete its entry and re-run.

```bash
python3 make_catalog.py
```

Then commit the regenerated `catalog.json` and `firmware/` folder and push.
Exactly one entry must have `default: True`.

### Build-time safety checks

`make_catalog.py` refuses to build, or warns loudly, when something is wrong:

- **CRC mismatch** — if a package's `.bin` and `.dat` don't belong together, the
  build fails. The bootloader would reject that image anyway; better to catch it
  before it ships.
- **Different boards** — if the packages don't all target the same device type
  and SoftDevice, it warns, because a customer could then pick an image their
  board will refuse.

Both current packages target device type `0x0052` with SoftDevice `0xB6`, so any
option is safe to flash onto any stick.

## How it works

The stick runs Adafruit's nRF52 bootloader, which accepts firmware over a serial
(CDC) link using Nordic's legacy DFU protocol. The page:

1. Loads `catalog.json` and builds the dropdown.
2. **Start update** → the customer picks the stick → the page sends a
   1200-baud "touch", which resets the board into its DFU bootloader. This is
   the same trick `arduino-cli -t 1200` used, so no button press is needed.
3. The board reconnects as a *new* USB device, so the browser asks the customer
   to pick it once more — Web Serial grants permission per device, and there's
   no way around this second prompt.
4. **Continue** → the page downloads the selected `.bin`/`.dat`, verifies the
   image's CRC16, then runs the DFU sequence: start packet (mode + image size),
   flash-erase wait, init packet, 512-byte data packets, stop packet.

The packet builder (SLIP framing, CRC16, sequence numbering) was verified
byte-for-byte against Adafruit's original Python `dfu_transport_serial.py`, and
the full flash loop was tested end-to-end against a mock bootloader that
reassembles the image and checks every frame.

## Local testing

Web Serial needs a secure context, so `file://` won't work. Serve locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000  (localhost counts as secure)
```
