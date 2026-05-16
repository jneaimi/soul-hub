#!/usr/bin/env python3
"""repairer — Recalculate totals, impute missing Quantity, drop incomplete rows."""
import os, json, sys
from pathlib import Path

# PIPELINE_DIR is set by the runner; its parent is pipelines/ which contains _builder/
_comp = Path(os.environ.get("PIPELINE_DIR", "")).parent / "_builder" / "components"
if not _comp.is_dir():
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


def to_float(val):
    """Convert to float or return None."""
    if val is None:
        return None
    val = str(val).strip()
    if not val:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise FileNotFoundError(f"Input CSV not found: {INPUT_PATH}")

    rows = read_csv(INPUT_PATH)
    if not rows:
        raise ValueError("CSV is empty")

    headers = list(rows[0].keys())
    repaired = []
    dropped = 0
    recalculated = 0
    imputed = 0

    for row in rows:
        item = row.get("Item", "").strip()
        qty = to_float(row.get("Quantity", ""))
        price = to_float(row.get("Price Per Unit", ""))
        total = to_float(row.get("Total Spent", ""))

        # Drop rows where Item AND Quantity AND Price Per Unit are all missing
        if not item and qty is None and price is None:
            dropped += 1
            continue

        # Impute missing Quantity as 1 if Price and Total both exist
        if qty is None and price is not None and total is not None and price > 0:
            qty = round(total / price)
            row["Quantity"] = str(int(qty)) if qty == int(qty) else str(qty)
            imputed += 1

        # Recalculate Total Spent = Quantity * Price Per Unit where both exist
        if qty is not None and price is not None:
            new_total = round(qty * price, 2)
            old_total = total
            row["Total Spent"] = str(new_total)
            if old_total is not None and abs(new_total - old_total) > 0.01:
                recalculated += 1
        elif total is None:
            row["Total Spent"] = ""

        repaired.append(row)

    if not OUTPUT_PATH:
        raise ValueError("PIPELINE_OUTPUT env var not set")

    write_csv(OUTPUT_PATH, repaired, headers=headers)
    print(f"Output: {OUTPUT_PATH}")
    print(f"Rows in: {len(rows)}, Rows out: {len(repaired)}, Dropped: {dropped}")
    print(f"Recalculated: {recalculated}, Imputed quantity: {imputed}")

    # Write stats as sidecar JSON for the quality report
    stats_path = Path(OUTPUT_PATH).parent / "repair-stats.json"
    stats = {
        "rows_in": len(rows),
        "rows_out": len(repaired),
        "dropped": dropped,
        "recalculated": recalculated,
        "imputed": imputed,
    }
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")


if __name__ == "__main__":
    with_error_handling(main)()
