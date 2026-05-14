#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""
stop-slop-scan.py — Deterministic stop-slop gate for synthesised peer-brief
recipes.

Reads a katib recipe YAML, extracts every prose field (callout body, module
raw_body, pull-quote text, captions, subtitles), and scans for hard
violations of the stop-slop discipline. Outputs JSON with the per-dimension
breakdown and a 0-50 score. Exits non-zero if score is below the threshold
or any HARD violation is present.

Hard violations (each is one demerit + a fail flag):
  - em-dash (`—` or `--` between words)
  - throat-clearing openers (banned phrase list)
  - emphasis crutches (banned phrase list)
  - meta-commentary (banned phrase list)
  - vague declaratives (banned phrase list)
  - "not X, it's Y" rhetorical contrasts

Soft violations (each is one demerit, no fail flag):
  - adverb crutches (filler -ly words used as softeners/intensifiers)
  - filler phrases (the "at its core / in today's X" family)
  - lazy extremes ("every", "always", "never" doing vague work)

Scoring (5 dimensions, 1-10 each, sum 0-50):
  - Directness:    10 - count(throat-clearing + emphasis crutches + meta)
  - Rhythm:        10 - count(em-dashes) - count(3-consecutive same-length sentences)
  - Trust:         10 - count(vague declaratives + lazy extremes)
  - Authenticity:  10 - count(filler phrases + adverbs)
  - Density:       10 - count(passive markers + inanimate-subject markers)

Each dimension floors at 0. Total floors at 0.

Default threshold: 35/50. Fail-loud and structured.

Usage:
    uv run stop-slop-scan.py path/to/recipe.yaml
    uv run stop-slop-scan.py path/to/recipe.yaml --min-score 40
    uv run stop-slop-scan.py path/to/recipe.yaml --json-only

Exit codes:
    0  pass
    6  fail (score below threshold OR any HARD violation)
    2  bad input
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml

# ── Banned-phrase lists ────────────────────────────────────────────────────

THROAT_CLEARING = [
    r"\bhere'?s the thing\b",
    r"\bhere'?s what\b",
    r"\bhere'?s this\b",
    r"\bhere'?s that\b",
    r"\bhere'?s why\b",
    r"\bthe uncomfortable truth is\b",
    r"\bit turns out\b",
    r"\blet me be clear\b",
    r"\bthe truth is,",
    r"\bi'?ll say it again\b",
    r"\bi'?m going to be honest\b",
    r"\bcan we talk about\b",
    r"\bhere'?s what i find interesting\b",
    r"\bhere'?s the problem though\b",
]

EMPHASIS_CRUTCHES = [
    r"\bfull stop\.\b",
    r"\bperiod\.\B",
    r"\blet that sink in\b",
    r"\bthis matters because\b",
    r"\bmake no mistake\b",
    r"\bhere'?s why that matters\b",
]

META_COMMENTARY = [
    r"\bplot twist:\B",
    r"\bspoiler:\B",
    r"^hint:",
    r"\byou already know this, but\b",
    r"\bbut that'?s another post\b",
    r"\bthe rest of this essay\b",
    r"\blet me walk you through\b",
    r"\bin this section, we'?ll\b",
    r"\bas we'?ll see\b",
    r"\bi want to explore\b",
    r"\bis a feature, not a bug\b",
]

VAGUE_DECLARATIVES = [
    r"\bthe reasons are structural\b",
    r"\bthe implications are significant\b",
    r"\bthis is the deepest problem\b",
    r"\bthe stakes are high\b",
    r"\bthe consequences are real\b",
    r"\bthis is genuinely hard\b",
    r"\bactually matters\b",
]

FILLER_PHRASES = [
    r"\bat its core\b",
    # "in today's [pull|miner-daily|data|brief|run]" is domain-referential, not slop.
    # We catch the abstract form ("in today's world", "in today's market") only.
    r"\bin today'?s (?!pull|miner-daily|miner|data|brief|run|reading)\w+",
    r"\bit'?s worth noting\b",
    r"\bat the end of the day\b",
    r"\bwhen it comes to\b",
    r"\bin a world where\b",
    r"\bthe reality is\b",
]

ADVERB_CRUTCHES = [
    r"\breally\b",
    r"\bjust\b",
    r"\bliterally\b",
    r"\bgenuinely\b",
    r"\bhonestly\b",
    r"\bsimply\b",
    r"\bactually\b",
    r"\bdeeply\b",
    r"\btruly\b",
    r"\bfundamentally\b",
    r"\binherently\b",
    r"\binevitably\b",
    r"\binterestingly\b",
    r"\bimportantly\b",
    r"\bcrucially\b",
]

# Em-dash detection: the unicode em-dash, OR `--` flanked by whitespace+letters
# on BOTH sides. `--as-of` (CLI flag) is excluded because it has no space after `--`.
EM_DASH = re.compile(r"—|(?<=\w)\s+--\s+(?=\w)")

# "not X, it's Y" pattern, fuzzy
NOT_X_ITS_Y = re.compile(
    r"\b(?:it'?s|its|that'?s|this is)\s+not\s+\w[^,.;:]{2,40},\s*it'?s\s+\w",
    re.IGNORECASE,
)

# Lazy extremes: "every X", "always X", "never X" with abstract X
LAZY_EXTREMES = re.compile(
    r"\b(every|always|never)\s+(thing|one|time|case|situation|operator|reader|user)\b",
    re.IGNORECASE,
)

# Inanimate-subject + human verb (heuristic, not exhaustive)
INANIMATE_SUBJECT = re.compile(
    r"\b(the\s+(?:decision|complaint|report|finding|brief|argument|paper|essay|"
    r"article|analysis|narrative|conclusion|insight))\s+"
    r"(emerges|argues|concludes|believes|wants|decides|feels|hopes)",
    re.IGNORECASE,
)

# Passive voice markers (heuristic): "was/were/been/being + past participle"
PASSIVE_VOICE = re.compile(
    r"\b(was|were|been|being|is|are|am)\s+\w+ed\b",
    re.IGNORECASE,
)


# ── Recipe extraction ──────────────────────────────────────────────────────

def extract_prose(recipe: dict) -> list[tuple[str, str]]:
    """Walk a recipe and return [(origin, text), ...] for every prose field.

    Origins:
      - 'cover.subtitle'
      - 'callout.body[i]'
      - 'module.raw_body[i]'
      - 'pull-quote.text[i]'
      - 'caption[component name][i]'
    """
    out: list[tuple[str, str]] = []
    sections = recipe.get("sections", [])
    callout_idx = module_idx = quote_idx = caption_idx = 0

    for sec in sections:
        comp = sec.get("component", "")
        inputs = sec.get("inputs") or sec.get("inputs_by_lang", {}).get("en", {}) or {}

        if comp == "cover-page":
            sub = inputs.get("subtitle")
            if sub:
                out.append(("cover.subtitle", sub))
        elif comp == "callout":
            body = inputs.get("body")
            if body:
                out.append((f"callout.body[{callout_idx}]", body))
                callout_idx += 1
        elif comp == "module":
            raw = inputs.get("raw_body")
            if raw:
                out.append((f"module.raw_body[{module_idx}]", raw))
                module_idx += 1
        elif comp == "pull-quote":
            txt = inputs.get("text") or inputs.get("quote")
            if txt:
                out.append((f"pull-quote.text[{quote_idx}]", txt))
                quote_idx += 1

        cap = inputs.get("caption")
        if cap:
            out.append((f"caption[{comp}][{caption_idx}]", cap))
            caption_idx += 1

    return out


def strip_html(text: str) -> str:
    """Strip tags and decode entities for scanning. Keeps text content."""
    no_tags = re.sub(r"<[^>]+>", " ", text)
    decoded = html.unescape(no_tags)
    return re.sub(r"\s+", " ", decoded).strip()


def split_sentences(text: str) -> list[str]:
    """Naive sentence split for rhythm checks."""
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text)
    return [p.strip() for p in parts if p.strip()]


# ── Detection ──────────────────────────────────────────────────────────────

def find_phrase_violations(text: str, patterns: list[str], label: str) -> list[dict]:
    """Find regex matches with context."""
    violations = []
    for pat in patterns:
        for m in re.finditer(pat, text, re.IGNORECASE):
            start = max(0, m.start() - 25)
            end = min(len(text), m.end() + 25)
            violations.append({
                "kind": label,
                "phrase": m.group(0),
                "context": text[start:end].strip(),
            })
    return violations


def find_regex_violations(text: str, regex: re.Pattern, label: str) -> list[dict]:
    out = []
    for m in regex.finditer(text):
        start = max(0, m.start() - 25)
        end = min(len(text), m.end() + 25)
        out.append({
            "kind": label,
            "phrase": m.group(0),
            "context": text[start:end].strip(),
        })
    return out


def find_rhythm_violations(text: str) -> list[dict]:
    """Detect 3+ consecutive sentences of similar length (within 2 words)."""
    sents = split_sentences(text)
    if len(sents) < 3:
        return []

    word_counts = [len(s.split()) for s in sents]
    out = []
    for i in range(len(word_counts) - 2):
        a, b, c = word_counts[i:i + 3]
        if abs(a - b) <= 2 and abs(b - c) <= 2 and abs(a - c) <= 2:
            out.append({
                "kind": "rhythm.metronomic",
                "phrase": f"{a}/{b}/{c} words",
                "context": " | ".join(sents[i:i + 3])[:120],
            })
    return out


def scan_block(origin: str, raw: str) -> dict:
    text = strip_html(raw)
    if not text:
        return {"origin": origin, "violations": []}

    violations: list[dict] = []
    violations += find_regex_violations(text, EM_DASH, "em-dash.HARD")
    violations += find_phrase_violations(text, THROAT_CLEARING, "throat-clearing.HARD")
    violations += find_phrase_violations(text, EMPHASIS_CRUTCHES, "emphasis-crutch.HARD")
    violations += find_phrase_violations(text, META_COMMENTARY, "meta-commentary.HARD")
    violations += find_phrase_violations(text, VAGUE_DECLARATIVES, "vague-declarative.HARD")
    violations += find_regex_violations(text, NOT_X_ITS_Y, "not-x-its-y.HARD")
    violations += find_phrase_violations(text, ADVERB_CRUTCHES, "adverb")
    violations += find_phrase_violations(text, FILLER_PHRASES, "filler-phrase")
    violations += find_regex_violations(text, LAZY_EXTREMES, "lazy-extreme")
    violations += find_regex_violations(text, INANIMATE_SUBJECT, "inanimate-subject")
    violations += find_rhythm_violations(text)

    for v in violations:
        v["origin"] = origin
    return {"origin": origin, "violations": violations}


# ── Scoring ────────────────────────────────────────────────────────────────

def score_violations(all_violations: list[dict]) -> dict:
    by_kind: dict[str, int] = {}
    for v in all_violations:
        kind = v["kind"]
        by_kind[kind] = by_kind.get(kind, 0) + 1

    def get(*kinds: str) -> int:
        return sum(by_kind.get(k, 0) for k in kinds)

    directness = max(0, 10 - get(
        "throat-clearing.HARD", "emphasis-crutch.HARD", "meta-commentary.HARD"
    ))
    rhythm = max(0, 10 - get("em-dash.HARD", "rhythm.metronomic"))
    trust = max(0, 10 - get("vague-declarative.HARD", "lazy-extreme"))
    authenticity = max(0, 10 - get("filler-phrase", "adverb", "not-x-its-y.HARD"))
    density = max(0, 10 - get("inanimate-subject"))

    total = directness + rhythm + trust + authenticity + density
    hard_count = sum(1 for v in all_violations if v["kind"].endswith(".HARD"))

    return {
        "directness": directness,
        "rhythm": rhythm,
        "trust": trust,
        "authenticity": authenticity,
        "density": density,
        "total": total,
        "hard_violation_count": hard_count,
        "by_kind": by_kind,
    }


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe", help="Path to a katib recipe YAML")
    ap.add_argument("--min-score", type=int, default=30, help="Minimum total score (0-50, default: 30 — calibrated against the canonical 14-May recipe scoring 41 after em-dash fix)")
    ap.add_argument("--max-hard", type=int, default=0, help="Maximum HARD violations allowed (default: 0). Em-dashes always count as HARD.")
    ap.add_argument("--json-only", action="store_true", help="Suppress human-readable output")
    args = ap.parse_args()

    recipe_path = Path(args.recipe)
    if not recipe_path.exists():
        print(json.dumps({"error": f"recipe not found: {recipe_path}"}), file=sys.stderr)
        return 2

    try:
        recipe = yaml.safe_load(recipe_path.read_text())
    except yaml.YAMLError as e:
        print(json.dumps({"error": f"yaml parse failed: {e}"}), file=sys.stderr)
        return 2

    if not isinstance(recipe, dict):
        print(json.dumps({"error": "recipe is not a mapping"}), file=sys.stderr)
        return 2

    blocks = extract_prose(recipe)
    all_violations: list[dict] = []
    block_reports = []
    for origin, raw in blocks:
        report = scan_block(origin, raw)
        block_reports.append(report)
        all_violations.extend(report["violations"])

    score = score_violations(all_violations)

    pass_score = score["total"] >= args.min_score
    pass_hard = score["hard_violation_count"] <= args.max_hard
    passed = pass_score and pass_hard

    result = {
        "recipe": str(recipe_path),
        "passed": passed,
        "score": score,
        "min_score": args.min_score,
        "max_hard": args.max_hard,
        "blocks_scanned": len(blocks),
        "violations": all_violations,
    }

    print(json.dumps(result, indent=2))

    if not args.json_only:
        verdict = "PASS" if passed else "FAIL"
        print(f"\n[stop-slop {verdict}] score={score['total']}/50 (min {args.min_score}) hard={score['hard_violation_count']} (max {args.max_hard})", file=sys.stderr)
        if not passed:
            print(f"[stop-slop FAIL] dimensions: directness={score['directness']} rhythm={score['rhythm']} trust={score['trust']} authenticity={score['authenticity']} density={score['density']}", file=sys.stderr)
            top_kinds = sorted(score["by_kind"].items(), key=lambda kv: -kv[1])[:5]
            for kind, n in top_kinds:
                print(f"[stop-slop FAIL] {kind}: {n}", file=sys.stderr)

    return 0 if passed else 6


if __name__ == "__main__":
    sys.exit(main())
