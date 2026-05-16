# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""dedup-headers — Remove duplicate header rows from a merged CSV."""
import os, sys
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

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise FileNotFoundError(f"Input CSV not found: {INPUT_PATH}")

    with open(INPUT_PATH, newline="", encoding="utf-8") as f:
        lines = f.readlines()

    if not lines:
        raise ValueError("CSV is empty")

    header = lines[0]
    out_lines = [header]
    removed = 0
    for line in lines[1:]:
        if line == header:
            removed += 1
        else:
            out_lines.append(line)

    if not OUTPUT_PATH:
        raise ValueError("PIPELINE_OUTPUT env var not set")

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", newline="", encoding="utf-8") as f:
        f.writelines(out_lines)

    print(f"Output: {OUTPUT_PATH}")
    print(f"Removed {removed} duplicate header rows")
    print(f"Rows: {len(out_lines) - 1}")


if __name__ == "__main__":
    with_error_handling(main)()
