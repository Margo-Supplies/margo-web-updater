#!/usr/bin/env python3
"""
Build the firmware catalog for the Margo web updater.

The updater now serves more than one product from a single page. The catalog is
therefore a list of PRODUCTS, each with its own flashing METHOD and its own list
of firmware options:

    nrf-dfu     Programmer Stick (Adafruit nRF52840). Flashed in the browser
                over Web Serial using Nordic's legacy DFU protocol (dfu.js).
                Each firmware is a DFU .zip (app.bin + app.dat init packet).

    samd-bossa  Avian Alarm, formerly "Squawk Box" (Arduino MKR Zero / SAMD21).
                Flashed in the browser over Web Serial using the Arduino SAM-BA
                bootloader's BOSSA protocol (bossa.js). Each firmware is one or
                more raw application .bin images written at flash offset 0x2000
                (an image may have a "wipe" stage that runs before the main app,
                mirroring the old SquawkBoxLoader two-step).

Usage:
    python3 make_catalog.py

Edit the PRODUCTS list below, then re-run. Commit the regenerated firmware/
folder and catalog.json.
"""

import json
import os
import shutil
import struct
import sys
import zipfile
from datetime import datetime, timezone

# ---------------------------------------------------------------- sources
PRODUCTS = [
    {
        "id": "stick",
        "name": "Programmer Stick",
        "aka": "",
        "board": "Adafruit Feather nRF52840",
        "blurb": "Updates in your browser — nothing to install.",
        "method": "nrf-dfu",
        "firmwares": [
            {
                "id": "stick",
                "label": "Programmer Stick (recommended)",
                "note": "The standard firmware for customer programmer sticks.",
                "zip": "packages/MargoProgrammerStick.zip",
                "default": True,
                "warn": False,
            },
            {
                "id": "dev",
                "label": "Developer build — internal use",
                "note": "Unreleased build for internal testing. Not for customer units.",
                "zip": "packages/nrf-cannon-programmer_ino.zip",
                "default": False,
                "warn": True,
            },
        ],
    },
    {
        "id": "avian-alarm",
        "name": "Avian Alarm",
        "aka": "formerly Squawk Box",
        "board": "Arduino MKR Zero (SAMD21)",
        "blurb": "Updates in your browser — nothing to install.",
        "method": "samd-bossa",
        # 8 KB Arduino SAMD bootloader; the application lives at 0x2000.
        "flashOffset": 0x2000,
        "fqbn": "arduino:samd:mkrzero",
        "firmwares": [
            {
                "id": "avian-full",
                "label": "Avian Alarm 1.5.1 (recommended)",
                "note": "Clears the device memory, then installs firmware 1.5.1. "
                        "Use this for a fresh unit or a clean reinstall.",
                "default": True,
                "warn": False,
                # Stages run in order. A "wipe" stage runs and is given runMs to
                # do its work before the device is put back into the bootloader
                # for the next stage.
                "stages": [
                    {"role": "wipe", "bin": "packages/avian-alarm/firmware_Wipe.bin",
                     "label": "memory clear", "runMs": 4000},
                    {"role": "app", "bin": "packages/avian-alarm/SquawkBoxV1.5.1.bin",
                     "label": "firmware 1.5.1"},
                ],
            },
            {
                "id": "avian-app",
                "label": "Avian Alarm 1.5.1 — firmware only (no memory clear)",
                "note": "Installs firmware 1.5.1 without clearing stored data. "
                        "Faster, for a device that's already set up.",
                "default": False,
                "warn": True,
                "stages": [
                    {"role": "app", "bin": "packages/avian-alarm/SquawkBoxV1.5.1.bin",
                     "label": "firmware 1.5.1"},
                ],
            },
        ],
    },
]

OUT_DIR = "firmware"
CATALOG = "catalog.json"


# ---------------------------------------------------------------- helpers
def calc_crc16_nrf(data, crc=0xFFFF):
    """CRC16 as used by the nRF52 legacy DFU bootloader (dfu.js calcCrc16)."""
    for b in data:
        crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00)
        crc ^= b
        crc ^= (crc & 0x00FF) >> 4
        crc ^= (crc << 8) << 4
        crc ^= ((crc & 0x00FF) << 4) << 1
    return crc & 0xFFFF


def calc_crc16_xmodem(data, crc=0x0000):
    """CRC16-CCITT/XMODEM — matches the SAM-BA bootloader 'Z' checksum
    (bossa.js checksumCalc) used to verify SAMD flash writes."""
    for b in data:
        crc ^= (b << 8) & 0xFFFF
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc & 0xFFFF


def parse_init_packet(dat):
    """Legacy (dfu_version 0.5) init packet layout."""
    if len(dat) < 14:
        raise ValueError("init packet (.dat) is shorter than expected")
    device_type, device_rev, app_version, sd_count = struct.unpack_from("<HHIH", dat, 0)
    sd_reqs = list(struct.unpack_from("<%dH" % sd_count, dat, 10))
    crc = struct.unpack_from("<H", dat, 10 + 2 * sd_count)[0]
    return {
        "device_type": device_type,
        "device_revision": device_rev,
        "application_version": app_version,
        "softdevice_req": sd_reqs,
        "firmware_crc16": crc,
    }


def fail(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------- nrf-dfu
def build_nrf_dfu(product, dest_root):
    entries = []
    device_types = {}
    for src in product["firmwares"]:
        if not os.path.exists(src["zip"]):
            fail("missing package: %s" % src["zip"])

        with zipfile.ZipFile(src["zip"]) as z:
            manifest = json.loads(z.read("manifest.json"))
            app = manifest["manifest"]["application"]
            bin_bytes = z.read(app["bin_file"])
            dat_bytes = z.read(app["dat_file"])

        init = parse_init_packet(dat_bytes)

        actual = calc_crc16_nrf(bin_bytes)
        if actual != init["firmware_crc16"]:
            fail("%s: firmware CRC mismatch — the .bin and .dat don't belong "
                 "together (bin=0x%04X, dat=0x%04X)" % (src["id"], actual, init["firmware_crc16"]))

        device_types[src["id"]] = (init["device_type"], tuple(init["softdevice_req"]))

        # Flat path per firmware id (firmware/stick, firmware/dev) — keeps the
        # existing committed layout so nothing has to be moved.
        dest = os.path.join(OUT_DIR, src["id"])
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, "app.bin"), "wb") as f:
            f.write(bin_bytes)
        with open(os.path.join(dest, "app.dat"), "wb") as f:
            f.write(dat_bytes)

        entries.append({
            "id": src["id"],
            "label": src["label"],
            "note": src.get("note", ""),
            "default": bool(src.get("default")),
            "warn": bool(src.get("warn")),
            "bin": "%s/%s/app.bin" % (OUT_DIR, src["id"]),
            "dat": "%s/%s/app.dat" % (OUT_DIR, src["id"]),
            "size": len(bin_bytes),
            "crc16": init["firmware_crc16"],
            "deviceType": init["device_type"],
            "softDeviceReq": init["softdevice_req"],
            "source": os.path.basename(src["zip"]),
        })
        print("  [%s] %-6s %-38s %7d B  crc=0x%04X  devType=0x%04X"
              % (product["id"], src["id"], src["label"], len(bin_bytes),
                 init["firmware_crc16"], init["device_type"]))

    distinct = set(device_types.values())
    if len(distinct) > 1:
        print("\nWARNING: %s packages don't all target the same board:" % product["id"], file=sys.stderr)
        for fid, dt in device_types.items():
            print("  %-6s deviceType=0x%04X softDeviceReq=%s" % (fid, dt[0], list(dt[1])), file=sys.stderr)
    return entries


# ---------------------------------------------------------------- samd-bossa
def build_samd_bossa(product, dest_root):
    entries = []
    for fw in product["firmwares"]:
        stages_out = []
        total = 0
        for i, st in enumerate(fw["stages"]):
            if not os.path.exists(st["bin"]):
                fail("missing firmware: %s" % st["bin"])
            with open(st["bin"], "rb") as f:
                data = f.read()
            crc = calc_crc16_xmodem(data)
            name = "%s-%s.bin" % (fw["id"], st["role"])
            dest = os.path.join(dest_root)
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, name), "wb") as f:
                f.write(data)
            stage = {
                "role": st["role"],
                "label": st.get("label", st["role"]),
                "bin": "%s/%s/%s" % (OUT_DIR, product["id"], name),
                "size": len(data),
                "crc16": crc,  # CCITT/XMODEM, matches the SAM-BA 'Z' verify
            }
            if "runMs" in st:
                stage["runMs"] = st["runMs"]
            stages_out.append(stage)
            total += len(data)
            print("  [%s] %-11s %-10s %7d B  crc=0x%04X"
                  % (product["id"], fw["id"], st["role"], len(data), crc))
        entries.append({
            "id": fw["id"],
            "label": fw["label"],
            "note": fw.get("note", ""),
            "default": bool(fw.get("default")),
            "warn": bool(fw.get("warn")),
            "stages": stages_out,
            "size": total,
        })
    return entries


# ---------------------------------------------------------------- build
def main():
    # Clean rebuild where possible. On some mounted/locked filesystems old files
    # can't be unlinked; in that case we fall back to overwriting in place.
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    products = []
    for product in PRODUCTS:
        n_default = sum(1 for f in product["firmwares"] if f.get("default"))
        if n_default != 1:
            fail("product '%s' must have exactly one firmware with default=True" % product["id"])

        dest_root = os.path.join(OUT_DIR, product["id"])
        os.makedirs(dest_root, exist_ok=True)

        if product["method"] == "nrf-dfu":
            fw_entries = build_nrf_dfu(product, dest_root)
        elif product["method"] == "samd-bossa":
            fw_entries = build_samd_bossa(product, dest_root)
        else:
            fail("unknown method '%s' for product '%s'" % (product["method"], product["id"]))

        p = {
            "id": product["id"],
            "name": product["name"],
            "aka": product.get("aka", ""),
            "board": product.get("board", ""),
            "blurb": product.get("blurb", ""),
            "method": product["method"],
            "firmwares": fw_entries,
        }
        if "flashOffset" in product:
            p["flashOffset"] = product["flashOffset"]
        if "fqbn" in product:
            p["fqbn"] = product["fqbn"]
        products.append(p)

    catalog = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "products": products,
    }
    with open(CATALOG, "w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")

    print("\nWrote %s and %s/ (%d product%s)"
          % (CATALOG, OUT_DIR, len(products), "" if len(products) == 1 else "s"))


if __name__ == "__main__":
    main()
