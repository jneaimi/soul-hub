#!/usr/bin/env python3
"""content_prep.py — Pre-process findings for Content Menu generation.

Generates a structured data pack that a lightweight AI agent reads to produce
an enriched content menu with titles, hooks, and angles.

Usage:
    python3 content_prep.py                     # Standard (1 day lookback)
    python3 content_prep.py --lookback 3        # 3 days of findings
    python3 content_prep.py --hot-only          # Only HOT items
"""

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from paths import MI_DB, MI_CONFIG, MI_OUTPUT, MI_DATE

DB_PATH = MI_DB
REPORTS_DIR = MI_OUTPUT
BRAND_ASSETS_PATH = MI_CONFIG / "brand-assets.md"
IDEAS_DIR = MI_OUTPUT / "ideas"
DATE = MI_DATE

PAIN_KEYWORDS = [
    "problem", "struggle", "frustrated", "broken", "fail", "can't", "won't",
    "painful", "stuck", "impossible", "nightmare", "hate", "help me", "how do i",
    "anyone else", "doesn't work", "not working", "wish", "need", "missing",
]


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ──────────────────────────────────────────────
# Dedup + Scoring
# ──────────────────────────────────────────────

def _normalize(title: str) -> str:
    t = title.lower().strip()
    t = re.sub(r"\*\*", "", t)
    t = t.strip('"').strip("'").strip('\u201c').strip('\u201d')
    t = re.split(r"\s*[—–-]\s+", t)[0]
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _words_overlap(a: str, b: str) -> float:
    words_a = set(a.split())
    words_b = set(b.split())
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / min(len(words_a), len(words_b))


def dedup_findings(findings: list[dict]) -> list[dict]:
    groups: list[list[dict]] = []
    for f in findings:
        norm = _normalize(f.get("title", ""))
        f["_norm"] = norm
        placed = False
        for group in groups:
            if _words_overlap(norm, group[0]["_norm"]) >= 0.6:
                group.append(f)
                placed = True
                break
        if not placed:
            groups.append([f])

    merged = []
    for group in groups:
        group.sort(key=lambda x: (
            1 if x.get("gcc_relevance") and x["gcc_relevance"] not in ("?", None, "") else 0,
            x.get("source_count") or 0,
            len(x.get("description") or ""),
        ), reverse=True)
        best = dict(group[0])
        best["source_count"] = max((g.get("source_count") or 0) for g in group)
        best["engagement_total"] = max((g.get("engagement_total") or 0) for g in group)
        if not best.get("gcc_relevance") or best["gcc_relevance"] in ("?", None, ""):
            for g in group[1:]:
                if g.get("gcc_relevance") and g["gcc_relevance"] not in ("?", None, ""):
                    best["gcc_relevance"] = g["gcc_relevance"]
                    break
        if not best.get("pillar") or best["pillar"] == "?":
            for g in group[1:]:
                if g.get("pillar") and g["pillar"] != "?":
                    best["pillar"] = g["pillar"]
                    break
        if not best.get("has_opportunity"):
            for g in group[1:]:
                if g.get("has_opportunity"):
                    best["has_opportunity"] = True
                    break
        best.pop("_norm", None)
        best["_merged_count"] = len(group)
        merged.append(best)
    return merged


SIGNAL_MAP = {"high": 3, "medium": 2, "low": 1}

def score_finding(f: dict) -> int:
    signal = SIGNAL_MAP.get((f.get("signal_strength") or "medium").lower(), 2)
    gcc = SIGNAL_MAP.get((f.get("gcc_relevance") or "low").lower(), 1)
    sources = f.get("source_count", 1) or 1
    source_score = 3 if sources >= 5 else (2 if sources >= 3 else 1)
    pillar = 2 if f.get("pillar") and f["pillar"] not in ("?", "") else 1
    has_opp = 2 if f.get("has_opportunity") else 0
    return (signal * 3) + (gcc * 3) + (source_score * 1) + (pillar * 2) + (has_opp * 1)


def classify(score: int) -> str:
    if score >= 20: return "HOT"
    elif score >= 12: return "WARM"
    return "SEED"


# ──────────────────────────────────────────────
# Data extraction
# ──────────────────────────────────────────────

def get_findings(db, lookback: int) -> list[dict]:
    rows = db.execute("""
        SELECT f.id, f.type, f.title, f.description, f.evidence,
               f.pillar, f.signal_strength, f.engagement_total,
               f.source_count, f.suggested_angle,
               ms.relevance as gcc_relevance, ms.context as gcc_context,
               ms.audience as gcc_audience,
               (SELECT COUNT(*) FROM opportunities o WHERE o.finding_id = f.id) as has_opportunity
        FROM findings f
        LEFT JOIN market_scores ms ON f.id = ms.finding_id AND ms.market = 'gcc'
        WHERE date(f.created_at) >= date('now', ? || ' days')
        ORDER BY f.signal_strength DESC, f.source_count DESC
    """, (f"-{lookback}",)).fetchall()
    return [dict(r) for r in rows]


def get_related_comments(db, finding_title: str, lookback: int) -> list[dict]:
    """Find audience comments related to a finding topic."""
    keywords = set(_normalize(finding_title).split())
    if not keywords:
        return []

    rows = db.execute("""
        SELECT c.author, c.content, c.likes, i.handle as post_author
        FROM comments c
        JOIN posts p ON c.post_id = p.id
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
          AND c.likes > 0
        ORDER BY c.likes DESC
        LIMIT 100
    """, (f"-{lookback}",)).fetchall()

    related = []
    for r in rows:
        content_lower = (r["content"] or "").lower()
        overlap = sum(1 for kw in keywords if kw in content_lower)
        if overlap >= 2 or (overlap >= 1 and r["likes"] >= 10):
            related.append(dict(r))
            if len(related) >= 5:
                break
    return related


def get_related_market_signals(db, finding_title: str, lookback: int) -> list[dict]:
    """Find top market signals related to a finding."""
    keywords = _normalize(finding_title).split()
    if not keywords:
        return []

    conditions = " OR ".join(f"ms.content LIKE '%{kw}%'" for kw in keywords[:4])
    rows = db.execute(f"""
        SELECT ms.platform, ms.author, ms.content, ms.likes, ms.views, ms.url,
               msr.topic
        FROM market_signals ms
        JOIN market_searches msr ON ms.search_id = msr.id
        WHERE ms.fetched_at >= datetime('now', ? || ' days')
          AND ({conditions})
        ORDER BY ms.likes DESC, ms.views DESC
        LIMIT 5
    """, (f"-{lookback}",)).fetchall()
    return [dict(r) for r in rows]


def get_transcript_quotes_for_finding(db, finding_title: str, lookback: int) -> list[dict]:
    """Extract relevant transcript quotes for a finding."""
    keywords = _normalize(finding_title).split()
    if not keywords:
        return []

    rows = db.execute("""
        SELECT i.handle, p.content as title, p.transcript, p.views
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
          AND p.transcript IS NOT NULL AND p.transcript != '' AND p.transcript != '[unavailable]'
        ORDER BY p.views DESC
    """, (f"-{lookback}",)).fetchall()

    quotes = []
    for row in rows:
        transcript = row["transcript"] or ""
        sentences = re.split(r'[.!?]+', transcript)
        for s in sentences:
            s = s.strip()
            s_lower = s.lower()
            if len(s) < 20:
                continue
            overlap = sum(1 for kw in keywords if kw in s_lower)
            if overlap >= 2:
                quotes.append({
                    "handle": row["handle"],
                    "views": row["views"],
                    "quote": s[:200],
                })
                if len(quotes) >= 3:
                    return quotes
    return quotes


def load_brand_assets() -> list[dict]:
    if not BRAND_ASSETS_PATH.exists():
        return []
    text = BRAND_ASSETS_PATH.read_text()
    assets = []
    for block in re.split(r"^###\s+", text, flags=re.MULTILINE)[1:]:
        lines = block.strip().splitlines()
        name = lines[0].strip()
        topics = []
        cta_en = cta_ar = ""
        for line in lines[1:]:
            m = re.search(r"topics?:\s*\[([^\]]+)\]", line, re.IGNORECASE)
            if m:
                topics = [t.strip().strip('"').strip("'").lower() for t in m.group(1).split(",")]
            m = re.search(r"cta_en:\s*(.+)", line, re.IGNORECASE)
            if m: cta_en = m.group(1).strip().strip('"')
            m = re.search(r"cta_ar:\s*(.+)", line, re.IGNORECASE)
            if m: cta_ar = m.group(1).strip().strip('"')
        if name:
            assets.append({"name": name, "topics": topics, "cta_en": cta_en, "cta_ar": cta_ar})
    return assets


def match_asset(title: str, desc: str, assets: list[dict]) -> dict | None:
    text = (title + " " + desc).lower()
    best = None
    best_score = 0
    for asset in assets:
        overlap = sum(1 for t in asset["topics"] if t in text)
        if overlap >= 2 and overlap > best_score:
            best = asset
            best_score = overlap
    return best


# ──────────────────────────────────────────────
# Generate prep
# ──────────────────────────────────────────────

def generate_prep(lookback: int, hot_only: bool = False) -> str:
    db = get_db()

    raw_findings = get_findings(db, lookback)
    findings = dedup_findings(raw_findings)
    log(f"Findings: {len(raw_findings)} raw -> {len(findings)} deduped")

    scored = []
    for f in findings:
        s = score_finding(f)
        tier = classify(s)
        scored.append({**f, "score": s, "tier": tier})
    scored.sort(key=lambda x: -x["score"])

    hot = [x for x in scored if x["tier"] == "HOT"][:3]
    warm = [] if hot_only else [x for x in scored if x["tier"] == "WARM" or
                                (x["tier"] == "HOT" and x not in hot)][:2]
    seeds = [x for x in scored if x not in hot and x not in warm]

    assets = load_brand_assets()

    miner_reports = sorted(REPORTS_DIR.glob("*miner-daily.md"), reverse=True)
    miner_report_name = miner_reports[0].name if miner_reports else "none"

    lines = [
        "---",
        "type: content-prep",
        f"created: {DATE}",
        f"lookback: {lookback}",
        "tags: [market-intel, content-prep]",
        "---",
        "",
        f"# Content Prep — {DATE}",
        "",
        f"**Pre-processed by:** content_prep.py (Python, no AI)",
        f"**Source:** {miner_report_name} + DB findings",
        f"**Findings:** {len(raw_findings)} raw -> {len(findings)} deduped",
        f"**HOT:** {len(hot)} | **WARM:** {len(warm)} | **SEEDS:** {len(seeds)}",
        "",
        "**YOUR JOB:** Read this prep and produce the content menu with:",
        "- Suggested titles (EN + AR) for each HOT/WARM item",
        "- A compelling hook (EN + AR) -- 1-2 sentences, evidence-first",
        "- Key data points to feature in the draft",
        "- Brand asset CTA if matched",
        "- Save the menu to the path specified at the bottom",
        "",
        "---",
        "",
        "## Scoring Summary",
        "",
        "| # | Topic | Score | Tier | Signal | GCC | Sources | Pillar | Opp |",
        "|---|-------|-------|------|--------|-----|---------|--------|-----|",
    ]

    for i, item in enumerate(hot + warm, 1):
        title = re.sub(r"\*\*", "", item.get("title", "")).strip('"')[:55]
        sig = (item.get("signal_strength") or "?").upper()
        gcc = (item.get("gcc_relevance") or "?").upper()
        lines.append(
            f"| {i} | {title} | **{item['score']}** | {item['tier']} | "
            f"{sig} | {gcc} | {item.get('source_count', 0)} | {item.get('pillar', '?')} | "
            f"{'yes' if item.get('has_opportunity') else 'no'} |"
        )
    lines.extend(["", "---", ""])

    for i, item in enumerate(hot + warm, 1):
        title = re.sub(r"\*\*", "", item.get("title", "")).strip('"').strip()
        tier_label = "HOT" if item in hot else "WARM"

        lines.extend([
            f"## Item {i:02d} — {title}",
            f"**Score: {item['score']} | Tier: {tier_label} | Type: {item.get('type', '?')} | Pillar: {item.get('pillar', '?')}**",
            "",
        ])

        if item.get("description"):
            lines.append(f"**Finding description:** {item['description']}")
            lines.append("")

        if item.get("evidence"):
            try:
                evidence = json.loads(item["evidence"]) if isinstance(item["evidence"], str) else item["evidence"]
                if isinstance(evidence, list) and evidence:
                    lines.append("**Evidence:**")
                    for e in evidence[:5]:
                        if isinstance(e, str):
                            lines.append(f"- {e[:150]}")
                        elif isinstance(e, dict):
                            lines.append(f"- {e.get('text', e.get('content', str(e)))[:150]}")
                    lines.append("")
            except (json.JSONDecodeError, TypeError):
                if isinstance(item["evidence"], str) and len(item["evidence"]) > 10:
                    lines.append(f"**Evidence:** {item['evidence'][:300]}")
                    lines.append("")

        if item.get("suggested_angle"):
            lines.append(f"**Miner's suggested angle:** {item['suggested_angle']}")
            lines.append("")

        if item.get("gcc_context"):
            lines.append(f"**GCC context:** {item['gcc_context']}")
        if item.get("gcc_audience"):
            lines.append(f"**GCC audience:** {item['gcc_audience']}")
        if item.get("gcc_context") or item.get("gcc_audience"):
            lines.append("")

        comments = get_related_comments(db, title, lookback * 2)
        if comments:
            lines.append("**Audience voice (top comments):**")
            for c in comments:
                lines.append(f"- @{c.get('author', '?')} ({c.get('likes', 0)} likes): \"{(c.get('content') or '')[:150]}\"")
            lines.append("")

        quotes = get_transcript_quotes_for_finding(db, title, lookback * 2)
        if quotes:
            lines.append("**Transcript quotes:**")
            for q in quotes:
                lines.append(f"> \"{q['quote']}\" — @{q['handle']} ({q.get('views', 0):,} views)")
            lines.append("")

        signals = get_related_market_signals(db, title, lookback * 2)
        if signals:
            lines.append("**Top market signals:**")
            for s in signals:
                content = (s.get("content") or "")[:120]
                lines.append(f"- @{s.get('author', '?')} ({s['platform']}, {s.get('likes', 0)} likes): {content}")
            lines.append("")

        asset = match_asset(title, item.get("description", ""), assets)
        if asset:
            lines.append(f"**Brand asset match:** {asset['name']}")
            if asset.get("cta_en"):
                lines.append(f"**CTA (EN):** {asset['cta_en']}")
            if asset.get("cta_ar"):
                lines.append(f"**CTA (AR):** {asset['cta_ar']}")
            lines.append("")

        lines.extend(["---", ""])

    if seeds:
        lines.extend([
            "## Seeds (score < 12, save for later)",
            "",
        ])
        for s in seeds[:10]:
            title = re.sub(r"\*\*", "", s.get("title", "")).strip('"')[:60]
            lines.append(f"- {title} (score: {s['score']}, type: {s.get('type', '?')})")
        lines.append("")

    lines.extend([
        "---",
        "",
        "## Output Instructions",
        "",
        f"Save the enriched content menu to: `{REPORTS_DIR}/{DATE}-content-menu.md`",
        f"(This prep file is at: `{REPORTS_DIR}/_prep/{DATE}-content-prep.md`)",
        f"Save seeds JSON to: `{IDEAS_DIR}/{DATE}-seeds.json`",
        "",
        "For each HOT/WARM item, your menu should include:",
        "1. **Title (EN)** -- punchy, curiosity-driven, under 80 chars",
        "2. **Title (AR)** -- rewrite not translate, matches brand voice",
        "3. **Hook (EN)** -- 1-2 sentences, lead with evidence/data, no throat-clearers",
        "4. **Hook (AR)** -- rewrite with GCC context, warm+professional tone",
        "5. **Key data points** -- 3-5 bullets: numbers, quotes, platform stats",
        "6. **Brand asset + CTA** -- if matched above",
        "7. **Draft command** -- `./scripts/draft.sh \"Title\"`",
        "",
        "Platform: LinkedIn only (weeks 1-12). EN + AR per item.",
    ])

    db.close()
    return "\n".join(lines)


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Content prep — pre-process for menu generation")
    parser.add_argument("--lookback", type=int, default=1, help="Lookback days (default: 1)")
    parser.add_argument("--hot-only", action="store_true", help="Only HOT items")
    args = parser.parse_args()

    start_time = time.time()
    log(f"Content prep starting — {DATE}")

    if not DB_PATH.exists():
        log("[ERROR] No database found")
        sys.exit(1)

    prep = generate_prep(args.lookback, args.hot_only)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    prep_dir = REPORTS_DIR / "_prep"
    prep_dir.mkdir(parents=True, exist_ok=True)
    output_path = prep_dir / f"{DATE}-content-prep.md"
    output_path.write_text(prep)

    elapsed = int(time.time() - start_time)
    line_count = len(prep.splitlines())

    log("=" * 40)
    log(f"Content prep ready — {elapsed}s, {line_count} lines")
    log(f"  Saved: {output_path}")
    log("=" * 40)

    print(json.dumps({
        "date": DATE,
        "output_path": str(output_path),
        "lines": line_count,
        "elapsed_seconds": elapsed,
    }))


if __name__ == "__main__":
    main()
