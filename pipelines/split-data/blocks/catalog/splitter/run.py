# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""splitter — Split a CSV file into chunks using csv_splitter component."""
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
from csv_splitter import split_csv

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")
CHUNK_SIZE = int(os.environ.get("BLOCK_CONFIG_CHUNK_SIZE", "2000"))
FORMAT = os.environ.get("BLOCK_CONFIG_FORMAT", "csv").lower()


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        print(f"Error: input file not found: {INPUT_PATH}", file=sys.stderr)
        sys.exit(1)

    if not OUTPUT_PATH:
        print("Error: PIPELINE_OUTPUT not set", file=sys.stderr)
        sys.exit(1)

    num_chunks = split_csv(INPUT_PATH, OUTPUT_PATH, CHUNK_SIZE, FORMAT)
    print(f"Split into {num_chunks} chunks of {CHUNK_SIZE} rows each")
    print(f"Output: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
