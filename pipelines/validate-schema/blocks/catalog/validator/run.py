#!/usr/bin/env python3
"""validator — Read CSV, check columns, detect types, count issues per column."""
import os, json, sys, csv
from pathlib import Path
from datetime import datetime

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
from output_writer import write_output

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")

EXPECTED_COLUMNS = [
    "Transaction ID", "Item", "Quantity", "Price Per Unit",
    "Total Spent", "Payment Method", "Location", "Transaction Date",
]

NUMERIC_COLUMNS = {"Quantity", "Price Per Unit", "Total Spent"}


def is_valid_date(val):
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            datetime.strptime(val.strip(), fmt)
            return True
        except ValueError:
            continue
    return False


def is_numeric(val):
    try:
        float(val)
        return True
    except (ValueError, TypeError):
        return False


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise FileNotFoundError(f"Input CSV not found: {INPUT_PATH}")

    with open(INPUT_PATH, newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        rows = list(reader)

    total_rows = len(rows)

    # Check expected columns
    missing_columns = [c for c in EXPECTED_COLUMNS if c not in headers]
    extra_columns = [c for c in headers if c not in EXPECTED_COLUMNS]

    # Count issues per column
    column_issues = {}
    for col in headers:
        issues = {"nulls": 0, "errors": 0, "unknowns": 0, "type_mismatches": 0}
        for row in rows:
            val = row.get(col, "").strip()
            if val == "" or val is None:
                issues["nulls"] += 1
            elif val.upper() == "ERROR":
                issues["errors"] += 1
            elif val.upper() == "UNKNOWN":
                issues["unknowns"] += 1
            elif col in NUMERIC_COLUMNS and not is_numeric(val):
                issues["type_mismatches"] += 1
            elif col == "Transaction Date" and val and not is_valid_date(val):
                issues["type_mismatches"] += 1
        column_issues[col] = issues

    # Math check: Total Spent != Quantity * Price Per Unit
    math_errors = 0
    for row in rows:
        qty = row.get("Quantity", "").strip()
        price = row.get("Price Per Unit", "").strip()
        total = row.get("Total Spent", "").strip()
        if is_numeric(qty) and is_numeric(price) and is_numeric(total):
            expected = round(float(qty) * float(price), 2)
            actual = round(float(total), 2)
            if abs(expected - actual) > 0.01:
                math_errors += 1

    # Summary totals
    total_nulls = sum(v["nulls"] for v in column_issues.values())
    total_errors = sum(v["errors"] for v in column_issues.values())
    total_unknowns = sum(v["unknowns"] for v in column_issues.values())
    total_type_mismatches = sum(v["type_mismatches"] for v in column_issues.values())

    report = {
        "total_rows": total_rows,
        "columns_found": headers,
        "missing_columns": missing_columns,
        "extra_columns": extra_columns,
        "column_issues": column_issues,
        "summary": {
            "total_nulls": total_nulls,
            "total_errors": total_errors,
            "total_unknowns": total_unknowns,
            "total_type_mismatches": total_type_mismatches,
            "math_errors": math_errors,
            "total_issues": total_nulls + total_errors + total_unknowns + total_type_mismatches + math_errors,
        },
    }

    write_output(report, fmt="json")


if __name__ == "__main__":
    with_error_handling(main)()
