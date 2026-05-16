#!/usr/bin/env python3
"""cleaner — Replace ERROR/UNKNOWN, standardize Payment Method, parse dates."""
import os, json, sys, csv, re
from pathlib import Path
from datetime import datetime

# PIPELINE_DIR is set by the runner; its parent is pipelines/ which contains _builder/
_comp = Path(os.environ.get("PIPELINE_DIR", "")).parent / "_builder" / "components"
if not _comp.is_dir():
    # Fallback for direct execution: walk up from script to find _builder/components
    _comp = Path(__file__).resolve().parent
    while _comp != _comp.parent:
        if (_comp / "_builder" / "components").is_dir():
            _comp = _comp / "_builder" / "components"
            break
        _comp = _comp.parent
sys.path.insert(0, str(_comp))
from error_handler import with_error_handling
from csv_writer import read_csv, write_csv

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

SENTINEL_VALUES = {"ERROR", "UNKNOWN", "error", "unknown", "Error", "Unknown"}

DATE_FORMATS = ["%Y-%m-%d", "%m/%d/%Y", "%d-%m-%Y", "%d/%m/%Y"]


def parse_date(val):
    """Try to parse a date string into YYYY-MM-DD. Return empty string on failure."""
    val = val.strip()
    if not val or val.upper() in ("ERROR", "UNKNOWN"):
        return ""
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(val, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def clean_value(val, column):
    """Replace sentinel values with empty string."""
    stripped = val.strip()
    if stripped in SENTINEL_VALUES:
        return ""
    return stripped


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise FileNotFoundError(f"Input CSV not found: {INPUT_PATH}")

    rows = read_csv(INPUT_PATH)
    if not rows:
        raise ValueError("CSV is empty")

    headers = list(rows[0].keys())
    cleaned = []

    for row in rows:
        new_row = {}
        for col in headers:
            val = row.get(col, "")
            val = clean_value(val, col)

            if col == "Payment Method" and val:
                val = val.strip().lower()

            if col == "Transaction Date":
                val = parse_date(row.get(col, ""))

            new_row[col] = val
        cleaned.append(new_row)

    if not OUTPUT_PATH:
        raise ValueError("PIPELINE_OUTPUT env var not set")

    write_csv(OUTPUT_PATH, cleaned, headers=headers)
    print(f"Output: {OUTPUT_PATH}")
    print(f"Cleaned {len(cleaned)} rows")


if __name__ == "__main__":
    with_error_handling(main)()
