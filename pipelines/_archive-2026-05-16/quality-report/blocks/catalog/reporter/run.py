# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""reporter — Compare before/after data quality and generate a markdown report."""
import os, json, csv, sys
from pathlib import Path

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

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
INPUT_COUNT = int(os.environ.get("PIPELINE_INPUT_COUNT", "1"))
INPUT_0 = os.environ.get("PIPELINE_INPUT_0", os.environ.get("PIPELINE_INPUT", ""))  # validation report
INPUT_1 = os.environ.get("PIPELINE_INPUT_1", "")  # repair-data output (repair-stats.json sidecar)
INPUT_2 = os.environ.get("PIPELINE_INPUT_2", "")  # final refined CSV from quality-check
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")


def read_validation_report(path: str) -> dict:
    if not path or not Path(path).exists():
        return {}
    with open(path) as f:
        return json.load(f)


def read_csv_stats(path: str) -> dict:
    if not path or not Path(path).exists():
        return {"rows": 0, "columns": [], "null_counts": {}}
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        columns = reader.fieldnames or []
        null_counts = {col: 0 for col in columns}
        row_count = 0
        for row in reader:
            row_count += 1
            for col in columns:
                val = row.get(col, "")
                if val is None or val.strip() == "":
                    null_counts[col] += 1
    return {"rows": row_count, "columns": columns, "null_counts": null_counts}


def read_repair_stats(csv_path: str) -> dict:
    stats_path = Path(csv_path).parent / "repair-stats.json"
    if stats_path.exists():
        with open(stats_path) as f:
            return json.load(f)
    return {}


def main():
    validation = read_validation_report(INPUT_0)
    # Use INPUT_2 (quality-check output) for final CSV stats, fall back to INPUT_1
    final_csv = INPUT_2 if INPUT_2 else INPUT_1
    csv_stats = read_csv_stats(final_csv)
    # Use INPUT_1 (repair-data output) to find repair-stats.json sidecar
    repair_stats = read_repair_stats(INPUT_1) if INPUT_1 else {}

    original_rows = validation.get("total_rows", 0)
    final_rows = csv_stats["rows"]
    rows_dropped = original_rows - final_rows
    drop_pct = (rows_dropped / original_rows * 100) if original_rows > 0 else 0

    summary = validation.get("summary", {})
    total_issues = summary.get("total_issues", 0)
    total_cells = original_rows * len(csv_stats["columns"]) if original_rows and csv_stats["columns"] else 1
    remaining_nulls = sum(csv_stats["null_counts"].values())
    quality_score = round((1 - remaining_nulls / total_cells) * 100, 1) if total_cells > 0 else 0

    lines = []
    lines.append("# Data Quality Report\n")
    lines.append("## Summary")
    lines.append(f"- **Original rows:** {original_rows:,}")
    lines.append(f"- **Final rows:** {final_rows:,}")
    lines.append(f"- **Rows dropped:** {rows_dropped:,} ({drop_pct:.1f}%)")
    lines.append(f"- **Data quality score:** {quality_score}/100")
    lines.append("")

    # Issues found before cleaning
    col_issues = validation.get("column_issues", {})
    if col_issues:
        lines.append("## Issues Found (Before Cleaning)\n")
        lines.append("| Column | Nulls | Errors | Unknowns | Type Mismatches |")
        lines.append("|--------|------:|-------:|---------:|----------------:|")
        for col, issues in col_issues.items():
            lines.append(
                f"| {col} | {issues.get('nulls', 0):,} | {issues.get('errors', 0):,} "
                f"| {issues.get('unknowns', 0):,} | {issues.get('type_mismatches', 0):,} |"
            )
        lines.append(f"\n**Total issues:** {total_issues:,}")
        lines.append("")

    # Repairs applied
    lines.append("## Repairs Applied\n")
    if repair_stats:
        lines.append(f"- **Rows processed:** {repair_stats.get('rows_in', 'N/A'):,}")
        lines.append(f"- **Rows output:** {repair_stats.get('rows_out', 'N/A'):,}")
        lines.append(f"- **Rows dropped:** {repair_stats.get('dropped', 0):,}")
        lines.append(f"- **Fields recalculated:** {repair_stats.get('recalculated', 0):,}")
        lines.append(f"- **Values imputed:** {repair_stats.get('imputed', 0):,}")
    else:
        lines.append("_No repair statistics file found._")
    lines.append("")

    # Remaining concerns
    lines.append("## Remaining Concerns\n")
    high_null_cols = {col: count for col, count in csv_stats["null_counts"].items() if count > 0}
    if high_null_cols:
        sorted_cols = sorted(high_null_cols.items(), key=lambda x: x[1], reverse=True)
        lines.append("| Column | Remaining Nulls | Null Rate |")
        lines.append("|--------|----------------:|----------:|")
        for col, count in sorted_cols:
            rate = (count / final_rows * 100) if final_rows > 0 else 0
            lines.append(f"| {col} | {count:,} | {rate:.1f}% |")
    else:
        lines.append("No remaining null values detected.")
    lines.append("")

    # Recommendations
    lines.append("## Recommendations\n")
    recs = []
    if high_null_cols:
        worst_col = max(high_null_cols, key=high_null_cols.get)
        worst_rate = high_null_cols[worst_col] / final_rows * 100 if final_rows > 0 else 0
        if worst_rate > 20:
            recs.append(f"- **{worst_col}** has {worst_rate:.0f}% null rate — consider dropping this column or sourcing fill data")
        elif worst_rate > 5:
            recs.append(f"- **{worst_col}** has {worst_rate:.0f}% null rate — review imputation strategy")
    if rows_dropped > 0:
        recs.append(f"- {rows_dropped:,} rows were dropped — review drop criteria for potential data recovery")
    if quality_score >= 95:
        recs.append("- Quality score is strong — data is ready for analysis")
    elif quality_score >= 80:
        recs.append("- Quality score is acceptable — consider a second cleaning pass for remaining issues")
    else:
        recs.append("- Quality score is below 80 — additional cleaning or manual review recommended")
    if not recs:
        recs.append("- No specific recommendations — data looks clean")
    lines.extend(recs)
    lines.append("")

    report = "\n".join(lines)

    if OUTPUT_PATH:
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            f.write(report)
        print(f"Output: {OUTPUT_PATH}")
    else:
        print(report)


if __name__ == "__main__":
    with_error_handling(main)()
