#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# ///
"""katib-stub build.py — fake katib build for katib-build component tests.

Mirrors the real katib build.py CLI shape so we can exercise every code path
of run.mjs (input validation, success stat-check, error_summary parsing,
timeout) without depending on the actual ~/dev/katib repo state.

Behaviours by recipe filename:
  happy.yaml  → writes a tiny fake PDF to --out, exits 0
  sad.yaml    → prints a multi-line WeasyPrint error trail, exits 1
  slow.yaml   → sleeps 10s (longer than test timeout), exits 0
  missing-pdf.yaml → prints success log but does NOT write the PDF, exits 0

Anything else → unknown-recipe error, exits 2.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("recipe")
    p.add_argument("--lang", default="en")
    p.add_argument("--brand", default="jasem")
    p.add_argument("--out", required=True)
    p.add_argument("--skip-audit-check", action="store_true")
    ns = p.parse_args()

    recipe_name = Path(ns.recipe).name

    if recipe_name == "happy.yaml":
        Path(ns.out).write_bytes(
            b"%PDF-1.5\n%katib-stub fake render\n"
            + b"-- lang=" + ns.lang.encode() + b" brand=" + ns.brand.encode() + b"\n"
            + b"%%EOF\n"
        )
        print(f"[katib-stub] rendered {ns.out} (lang={ns.lang} brand={ns.brand})")
        return 0

    if recipe_name == "sad.yaml":
        print("[katib-stub] parsing recipe", file=sys.stderr)
        print("[katib-stub] running render", file=sys.stderr)
        print("ERROR: WeasyPrint failed: invalid CSS at line 42", file=sys.stderr)
        print("       html5lib could not resolve the document tree", file=sys.stderr)
        return 1

    if recipe_name == "slow.yaml":
        time.sleep(10)
        return 0

    if recipe_name == "missing-pdf.yaml":
        print("[katib-stub] build complete (but no PDF written — simulating disk fail)")
        return 0

    print(f"[katib-stub] unknown recipe: {recipe_name}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
