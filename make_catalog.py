#!/usr/bin/env python3
"""
Build the firmware catalog for the Margo web updater.

Reads one or more DFU .zip packages, writes the raw .bin/.dat for each into
firmware/<id>/, and emits catalog.json describing the menu the customer sees.

Usage:
    python3 make_catalog.py

Edit the SOURCES list below to add, remove, or relabel firmware options,
then re-run. Commit the regenerated firmware/ folder and catalog.json.

Each entry:
    id      folder name + value used in the page (keep it short, no spaces)
    label   what the customer sees in the dropdown
    note    one line shown under the menu once selected
    zip     path to the DFU .zip
    default True on exactly one entry: what's preselected on page load
    warn    True to show the option with a caution style (e.g. dev builds)
"""

import json
import os
import shutil
import struct
import sys
import zipfile
from datetime import datetime, timezone

# ---------------------------------------------------------------- sources
SOURCES = [
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
        "label": "Developer build \u2014 internal use",
        "note": "Unreleased build for internal testing. Not for customer units.",
        "zip": "packages/nrf-cannon-programmer_ino.zip",
        "default": False,
        "warn": True,
    },
]

OUT_DIR = "firmware"
CATALOG = "catalog.json"


# ---------------------------------------------------------------- helpers
def calc_crc16(data, crc=0xFFFF):
    """CRC16 as used by the nRF52 legacy DFU bootloader."""
    for b in data:
        crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00)
        crc ^= b
        crc ^= (crc & 0x00FF) >> 4
        crc ^= (crc << 8) << 4
        crc ^= ((crc & 0x00FF) << 4) << 1
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


# ---------------------------------------------------------------- build
def main():
    if sum(1 for s in SOURCES if s.get("default")) != 1:
        fail("exactly one entry in SOURCES must have default=True")

    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR)

    entries = []
    device_types = {}

    for src in SOURCES:
        if not os.path.exists(src["zip"]):
            fail("missing package: %s" % src["zip"])

        with zipfile.ZipFile(src["zip"]) as z:
            manifest = json.loads(z.read("manifest.json"))
            app = manifest["manifest"]["application"]
            bin_bytes = z.read(app["bin_file"])
            dat_bytes = z.read(app["dat_file"])

        init = parse_init_packet(dat_bytes)

        # The bootloader rejects an image whose CRC doesn't match its init
        # packet. Catch a mismatched bin/dat pairing here instead of shipping it.
        actual = calc_crc16(bin_bytes)
        if actual != init["firmware_crc16"]:
            fail(
                "%s: firmware CRC mismatch \u2014 the .bin and .dat in this package "
                "don't belong together (bin=0x%04X, dat=0x%04X)"
                % (src["id"], actual, init["firmware_crc16"])
            )

        device_types[src["id"]] = (init["device_type"], tuple(init["softdevice_req"]))

        dest = os.path.join(OUT_DIR, src["id"])
        os.makedirs(dest)
        with open(os.path.join(dest, "app.bin"), "wb") as f:
            f.write(bin_bytes)
        with open(os.path.join(dest, "app.dat"), "wb") as f:
            f.write(dat_bytes)

        entries.append(
            {
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
            }
        )

        print(
            "  %-6s %-38s %7d B  crc=0x%04X  devType=0x%04X"
            % (src["id"], src["label"], len(bin_bytes), init["firmware_crc16"], init["device_type"])
        )

    # All options are offered from one page against one connected board, so a
    # differing device type would mean a customer could pick an image the board
    # will refuse. Flag it loudly at build time.
    distinct = set(device_types.values())
    if len(distinct) > 1:
        print("\nWARNING: these packages do NOT all target the same board:", file=sys.stderr)
        for fid, dt in device_types.items():
            print("  %-6s deviceType=0x%04X softDeviceReq=%s" % (fid, dt[0], list(dt[1])), file=sys.stderr)
        print("Customers could select firmware their board will reject.\n", file=sys.stderr)

    catalog = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "product": "Margo Programmer Stick",
        "firmwares": entries,
    }
    with open(CATALOG, "w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")

    print("\nWrote %s and %s/ (%d option%s)" % (CATALOG, OUT_DIR, len(entries), "" if len(entries) == 1 else "s"))


if __name__ == "__main__":
    main()
