#!/usr/bin/env python3
"""Collect step: Pick a random quote from the source file and write as JSON."""

import json
import os
import random
import sys


def main():
    # Input file path passed as first argument or from PIPELINE_INPUT env
    input_file = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PIPELINE_INPUT", "")
    output_file = os.environ.get("PIPELINE_OUTPUT", "/tmp/collected.json")

    if not input_file or not os.path.exists(input_file):
        print(json.dumps({"error": f"Quotes file not found: {input_file}"}))
        sys.exit(1)

    with open(input_file) as f:
        lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]

    if not lines:
        print(json.dumps({"error": "No quotes found in file"}))
        sys.exit(1)

    # Pick a random quote
    line = random.choice(lines)

    # Parse "quote — author" format
    if " — " in line:
        quote, author = line.rsplit(" — ", 1)
    elif " - " in line:
        quote, author = line.rsplit(" - ", 1)
    else:
        quote, author = line, "Unknown"

    result = {
        "quote": quote.strip(),
        "author": author.strip(),
        "source_file": input_file,
        "total_quotes": len(lines),
    }

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, "w") as f:
        json.dump(result, f, indent=2)

    print(f"Collected quote by {author.strip()}")
    print(json.dumps({"status": "done", "output": output_file}))


if __name__ == "__main__":
    main()
