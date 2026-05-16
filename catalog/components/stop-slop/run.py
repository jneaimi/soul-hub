#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
stop-slop component v1.0.0 — deterministic content quality gate.

I/O contract (see BLOCK.md):
  stdin:  { text: str, rubric?: str, min_score?: int, block_on_fail?: bool }
  stdout: { score, passed, per_dimension, hard_violations, soft_violation_count, by_kind }
  exit:   0 pass | 6 fail (when block_on_fail) | 2 bad input

Banned-phrase lists and dimension formulas are kept verbatim with
scripts/peer-brief/stop-slop-scan.py — when peer-brief migrates to a Naseej
recipe the two will share lib_stop_slop.py.
"""
from __future__ import annotations

import html
import json
import re
import sys
from typing import Any

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

EM_DASH = re.compile(r"—|(?<=\w)\s+--\s+(?=\w)")

NOT_X_ITS_Y = re.compile(
    r"\b(?:it'?s|its|that'?s|this is)\s+not\s+\w[^,.;:]{2,40},\s*it'?s\s+\w",
    re.IGNORECASE,
)

LAZY_EXTREMES = re.compile(
    r"\b(every|always|never)\s+(thing|one|time|case|situation|operator|reader|user)\b",
    re.IGNORECASE,
)

INANIMATE_SUBJECT = re.compile(
    r"\b(the\s+(?:decision|complaint|report|finding|brief|argument|paper|essay|"
    r"article|analysis|narrative|conclusion|insight))\s+"
    r"(emerges|argues|concludes|believes|wants|decides|feels|hopes)",
    re.IGNORECASE,
)


# ── Helpers ────────────────────────────────────────────────────────────────

def strip_html(text: str) -> str:
    no_tags = re.sub(r"<[^>]+>", " ", text)
    decoded = html.unescape(no_tags)
    return re.sub(r"\s+", " ", decoded).strip()


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text)
    return [p.strip() for p in parts if p.strip()]


def find_phrase_violations(text: str, patterns: list[str], label: str) -> list[dict]:
    out = []
    for pat in patterns:
        for m in re.finditer(pat, text, re.IGNORECASE):
            start = max(0, m.start() - 25)
            end = min(len(text), m.end() + 25)
            out.append({
                "kind": label,
                "phrase": m.group(0),
                "context": text[start:end].strip(),
            })
    return out


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


# ── Core scan ──────────────────────────────────────────────────────────────

def scan_text(raw: str) -> list[dict]:
    text = strip_html(raw)
    if not text:
        return []
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
    return violations


def score_violations(all_violations: list[dict]) -> dict:
    by_kind: dict[str, int] = {}
    for v in all_violations:
        by_kind[v["kind"]] = by_kind.get(v["kind"], 0) + 1

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
    soft_count = len(all_violations) - hard_count

    return {
        "per_dimension": {
            "directness": directness,
            "rhythm": rhythm,
            "trust": trust,
            "authenticity": authenticity,
            "density": density,
        },
        "score": total,
        "hard_violation_count": hard_count,
        "soft_violation_count": soft_count,
        "by_kind": by_kind,
    }


# ── Entry point ────────────────────────────────────────────────────────────

def fail(msg: str) -> int:
    print(json.dumps({"error": msg}), file=sys.stdout)
    return 2


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        return fail(f"stdin is not valid JSON: {e}")

    if not isinstance(payload, dict):
        return fail("stdin JSON must be an object")

    text = payload.get("text")
    if not isinstance(text, str):
        return fail("missing or non-string `text` field")

    rubric = payload.get("rubric", "default")
    if rubric not in ("default", "peer-brief", "linkedin", "arabic"):
        return fail(f"unknown rubric: {rubric!r}")

    min_score = payload.get("min_score", 35)
    if not isinstance(min_score, int) or not 0 <= min_score <= 50:
        return fail("`min_score` must be int 0..50")

    block_on_fail = payload.get("block_on_fail", True)
    if not isinstance(block_on_fail, bool):
        return fail("`block_on_fail` must be bool")

    violations = scan_text(text)
    scored = score_violations(violations)

    hard_violations = [v for v in violations if v["kind"].endswith(".HARD")]
    passed = scored["score"] >= min_score and scored["hard_violation_count"] == 0

    result: dict[str, Any] = {
        "score": scored["score"],
        "passed": passed,
        "per_dimension": scored["per_dimension"],
        "hard_violations": hard_violations,
        "soft_violation_count": scored["soft_violation_count"],
        "by_kind": scored["by_kind"],
        "min_score": min_score,
        "rubric": rubric,
    }

    print(json.dumps(result, indent=2))

    if not passed and block_on_fail:
        return 6
    return 0


if __name__ == "__main__":
    sys.exit(main())
