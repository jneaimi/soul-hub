# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""output-cleaner — Extract and normalize JSON from agent output."""
import os, json, sys, re
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
from output_writer import write_output

INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")


def try_parse_json(text: str) -> dict | None:
    """Try to parse text as JSON, return dict or None."""
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, ValueError):
        pass
    return None


def extract_json(raw: str) -> dict:
    """Extract JSON from raw text using multiple strategies."""
    # Strategy 1: Direct parse
    result = try_parse_json(raw)
    if result:
        return result

    # Strategy 2: Extract from markdown code fences (```json ... ``` or ``` ... ```)
    fence_pattern = re.compile(r"```(?:json)?\s*\n(.*?)\n```", re.DOTALL)
    for match in fence_pattern.finditer(raw):
        result = try_parse_json(match.group(1).strip())
        if result:
            return result

    # Strategy 3: Find outermost { ... } brace pair
    first_brace = raw.find("{")
    last_brace = raw.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        result = try_parse_json(raw[first_brace : last_brace + 1])
        if result:
            return result

    # Strategy 4: Try to find a JSON array and wrap it
    first_bracket = raw.find("[")
    last_bracket = raw.rfind("]")
    if first_bracket != -1 and last_bracket > first_bracket:
        try:
            arr = json.loads(raw[first_bracket : last_bracket + 1])
            if isinstance(arr, list):
                return {"cafes": arr}
        except (json.JSONDecodeError, ValueError):
            pass

    raise ValueError("Could not extract valid JSON from agent output")


def normalize_structure(data: dict) -> dict:
    """Ensure the data has the expected top-level keys for report-builder."""
    # Already has 'cafes' key with a list — good to go
    if "cafes" in data and isinstance(data["cafes"], list):
        return data

    # Alternative key names agents sometimes use
    for key in ("all_cafes", "cafe_analysis", "results", "cafe_list", "analyzed_cafes"):
        if key in data and isinstance(data[key], list):
            data["cafes"] = data.pop(key)
            return data

    # If there's a single list value at top level, assume it's the cafes
    list_values = [(k, v) for k, v in data.items() if isinstance(v, list) and v and isinstance(v[0], dict)]
    if len(list_values) == 1:
        key, val = list_values[0]
        data["cafes"] = val
        if key != "cafes":
            del data[key]
        return data

    # Wrap entire dict if it looks like a single cafe
    if "name" in data and ("deal_score" in data or "rating" in data):
        return {"cafes": [data]}

    # Return as-is — report-builder's normalize() will handle remaining cases
    return data


def main():
    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        raise RuntimeError("No input file — PIPELINE_INPUT not set or file missing")

    raw = Path(INPUT_PATH).read_text().strip()
    if not raw:
        raise RuntimeError("Input file is empty")

    data = extract_json(raw)
    data = normalize_structure(data)

    cafe_count = len(data.get("cafes", []))
    write_output(data, fmt="json")
    print(f"Cleaned output — {cafe_count} cafes extracted")


if __name__ == "__main__":
    with_error_handling(main)()
