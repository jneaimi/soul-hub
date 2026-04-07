#!/usr/bin/env python3
"""weekly_prep.py — Pre-process data for Miner weekly + Strategist.

Generates a structured data pack (markdown) that AI agents read instead of
doing 20+ SQL queries themselves. Reduces agent token usage by ~40-60%.

Usage:
    python3 weekly_prep.py                      # Standard (7 days)
    python3 weekly_prep.py --lookback-days 14   # Override lookback
    python3 weekly_prep.py --for strategist     # Strategist-focused prep (multi-week)
"""

import argparse
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from paths import MI_DB, MI_CONFIG, MI_OUTPUT, MI_DATE

DB_PATH = MI_DB
REPORTS_DIR = MI_OUTPUT
BRAND_ASSETS_PATH = MI_CONFIG / "brand-assets.md"
DATE = MI_DATE

PAIN_KEYWORDS = [
    "problem", "struggle", "frustrated", "broken", "fail", "can't", "won't",
    "painful", "annoying", "bug", "issue", "stuck", "impossible", "nightmare",
    "hate", "terrible", "worst", "help me", "how do i", "anyone else",
    "doesn't work", "not working", "wish", "need", "missing", "lacking",
    "\u0645\u0634\u0643\u0644\u0629", "\u0635\u0639\u0628", "\u0644\u0627 \u064a\u0639\u0645\u0644", "\u0645\u062d\u0628\u0637", "\u0643\u064a\u0641", "\u0623\u062d\u062a\u0627\u062c", "\u0646\u0627\u0642\u0635",
]


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ──────────────────────────────────────────────
# Data extraction
# ──────────────────────────────────────────────

def get_influencer_summary(db, lookback: int) -> list[dict]:
    rows = db.execute("""
        SELECT i.handle, i.platform, COUNT(p.id) as post_count,
               SUM(p.views) as total_views, SUM(p.likes) as total_likes,
               SUM(p.comments_count) as total_comments,
               GROUP_CONCAT(SUBSTR(p.content, 1, 100), ' ||| ') as titles
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
        GROUP BY i.handle, i.platform
        ORDER BY total_views DESC
    """, (f"-{lookback}",)).fetchall()
    return [dict(r) for r in rows]


def get_top_posts(db, lookback: int, limit: int = 15) -> list[dict]:
    rows = db.execute("""
        SELECT i.handle, i.platform, p.content, p.views, p.likes,
               p.comments_count, p.post_date, p.url,
               CASE WHEN p.transcript IS NOT NULL AND p.transcript != '' AND p.transcript != '[unavailable]'
                    THEN 1 ELSE 0 END as has_transcript
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
        ORDER BY p.views DESC
        LIMIT ?
    """, (f"-{lookback}", limit)).fetchall()
    return [dict(r) for r in rows]


def get_transcript_excerpts(db, lookback: int, max_chars: int = 500) -> list[dict]:
    rows = db.execute("""
        SELECT i.handle, p.content as title, p.transcript, p.views
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
          AND p.transcript IS NOT NULL
          AND p.transcript != '' AND p.transcript != '[unavailable]'
        ORDER BY p.views DESC
    """, (f"-{lookback}",)).fetchall()

    excerpts = []
    for row in rows:
        transcript = row["transcript"]
        if not transcript or len(transcript) < 100:
            continue

        sentences = re.split(r'[.!?]+', transcript)
        key_sentences = []
        for s in sentences:
            s = s.strip()
            if len(s) < 20:
                continue
            s_lower = s.lower()
            if any(kw in s_lower for kw in PAIN_KEYWORDS + ["important", "critical", "key", "biggest", "main"]):
                key_sentences.append(s)
            if len(key_sentences) >= 3:
                break

        if key_sentences:
            excerpts.append({
                "handle": row["handle"],
                "title": (row["title"] or "")[:80],
                "views": row["views"],
                "quotes": key_sentences[:3],
            })

    return excerpts


def get_market_signal_topics(db, lookback: int) -> list[dict]:
    rows = db.execute("""
        SELECT ms_search.topic, COUNT(ms.id) as signal_count,
               SUM(ms.likes) as total_likes, SUM(ms.views) as total_views,
               COUNT(DISTINCT ms.platform) as platforms,
               GROUP_CONCAT(DISTINCT ms.platform) as platform_list
        FROM market_signals ms
        JOIN market_searches ms_search ON ms.search_id = ms_search.id
        WHERE ms.fetched_at >= datetime('now', ? || ' days')
        GROUP BY ms_search.topic
        ORDER BY total_views DESC
    """, (f"-{lookback}",)).fetchall()
    return [dict(r) for r in rows]


def get_pain_signals(db, lookback: int, limit: int = 30) -> list[dict]:
    rows = db.execute("""
        SELECT ms.platform, ms.author, ms.content, ms.likes, ms.views, ms.url,
               ms_search.topic
        FROM market_signals ms
        JOIN market_searches ms_search ON ms.search_id = ms_search.id
        WHERE ms.fetched_at >= datetime('now', ? || ' days')
          AND ms.content IS NOT NULL AND LENGTH(ms.content) > 30
        ORDER BY ms.likes DESC
    """, (f"-{lookback}",)).fetchall()

    pain_signals = []
    for row in rows:
        content = (row["content"] or "").lower()
        if any(kw in content for kw in PAIN_KEYWORDS):
            pain_signals.append(dict(row))
            if len(pain_signals) >= limit:
                break

    return pain_signals


def get_top_comments(db, lookback: int, limit: int = 20) -> list[dict]:
    rows = db.execute("""
        SELECT c.author, c.content, c.likes, i.handle as post_author,
               p.content as post_title
        FROM comments c
        JOIN posts p ON c.post_id = p.id
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
          AND c.likes > 0
        ORDER BY c.likes DESC
        LIMIT ?
    """, (f"-{lookback}", limit)).fetchall()
    return [dict(r) for r in rows]


def get_finding_persistence(db, lookback_days: int) -> list[dict]:
    rows = db.execute("""
        SELECT title, type, pillar, signal_strength,
               COUNT(*) as appearances,
               COUNT(DISTINCT date(created_at)) as days_appeared,
               MIN(date(created_at)) as first_seen,
               MAX(date(created_at)) as last_seen,
               MAX(engagement_total) as peak_engagement,
               MAX(source_count) as max_sources
        FROM findings
        WHERE created_at >= datetime('now', ? || ' days')
        GROUP BY title
        ORDER BY days_appeared DESC, appearances DESC
    """, (f"-{lookback_days}",)).fetchall()
    return [dict(r) for r in rows]


def get_opportunity_evolution(db, lookback_days: int) -> list[dict]:
    rows = db.execute("""
        SELECT o.category, o.title, o.priority, o.status,
               f.title as finding_title, f.signal_strength,
               date(o.created_at) as created
        FROM opportunities o
        JOIN findings f ON o.finding_id = f.id
        WHERE o.created_at >= datetime('now', ? || ' days')
        ORDER BY o.created_at DESC
    """, (f"-{lookback_days}",)).fetchall()
    return [dict(r) for r in rows]


def detect_convergence(influencer_posts: list[dict], market_topics: list[dict]) -> list[dict]:
    convergences = []

    influencer_keywords = defaultdict(int)
    for post in influencer_posts:
        title = (post.get("content") or post.get("titles") or "").lower()
        for word in re.findall(r'\b[a-z]{4,}\b', title):
            influencer_keywords[word] += 1

    for topic in market_topics:
        topic_name = (topic.get("topic") or "").lower()
        topic_words = set(re.findall(r'\b[a-z]{4,}\b', topic_name))
        overlap = sum(influencer_keywords.get(w, 0) for w in topic_words)
        if overlap >= 2:
            convergences.append({
                "topic": topic.get("topic"),
                "market_signals": topic.get("signal_count", 0),
                "market_views": topic.get("total_views", 0),
                "influencer_overlap_score": overlap,
                "platforms": topic.get("platform_list", ""),
            })

    convergences.sort(key=lambda x: -x["influencer_overlap_score"])
    return convergences[:10]


def load_brand_assets() -> list[dict]:
    if not BRAND_ASSETS_PATH.exists():
        return []
    text = BRAND_ASSETS_PATH.read_text()
    assets = []
    for block in re.split(r"^###\s+", text, flags=re.MULTILINE)[1:]:
        lines = block.strip().splitlines()
        name = lines[0].strip()
        topics = []
        for line in lines[1:]:
            m = re.search(r"topics?:\s*\[([^\]]+)\]", line, re.IGNORECASE)
            if m:
                topics = [t.strip().strip('"').strip("'").lower() for t in m.group(1).split(",")]
        if name:
            assets.append({"name": name, "topics": topics})
    return assets


def match_assets_to_topics(topics: list[str], assets: list[dict]) -> dict[str, str]:
    matches = {}
    for topic in topics:
        topic_lower = topic.lower()
        best_asset = None
        best_score = 0
        for asset in assets:
            overlap = sum(1 for t in asset["topics"] if t in topic_lower)
            if overlap >= 2 and overlap > best_score:
                best_asset = asset["name"]
                best_score = overlap
        if best_asset:
            matches[topic] = best_asset
    return matches


# ──────────────────────────────────────────────
# Generate data pack
# ──────────────────────────────────────────────

def generate_data_pack(lookback: int, mode: str = "miner") -> str:
    db = get_db()

    log("Querying influencer posts...")
    influencers = get_influencer_summary(db, lookback)
    top_posts = get_top_posts(db, lookback)

    log("Extracting transcript quotes...")
    transcript_excerpts = get_transcript_excerpts(db, lookback)

    log("Aggregating market signals by topic...")
    market_topics = get_market_signal_topics(db, lookback)

    log("Extracting pain signals...")
    pain_signals = get_pain_signals(db, lookback)

    log("Getting top comments (audience voice)...")
    top_comments = get_top_comments(db, lookback)

    log("Detecting convergence (influencer x market)...")
    convergences = detect_convergence(top_posts, market_topics)

    assets = load_brand_assets()
    topic_names = [t["topic"] for t in market_topics if t.get("topic")]
    asset_matches = match_assets_to_topics(topic_names, assets)

    finding_persistence = []
    opp_evolution = []
    if mode == "strategist":
        log("Computing finding persistence (multi-week)...")
        finding_persistence = get_finding_persistence(db, lookback)
        opp_evolution = get_opportunity_evolution(db, lookback)

    db.close()

    lines = [
        "---",
        "type: data-pack",
        f"created: {DATE}",
        f"lookback_days: {lookback}",
        f"mode: {mode}",
        "tags: [market-intel, data-pack, pre-processed]",
        "---",
        "",
        f"# Weekly Data Pack — {DATE}",
        "",
        f"**Pre-processed by:** weekly_prep.py (deterministic, no AI)",
        f"**Lookback:** {lookback} days | **Mode:** {mode}",
        f"**Purpose:** Read this instead of querying the DB directly. Focus on analysis, not data gathering.",
        "",
        "---",
        "",
    ]

    total_posts = sum(i.get("post_count", 0) for i in influencers)
    total_signals = sum(t.get("signal_count", 0) for t in market_topics)
    total_views = sum(p.get("views", 0) for p in top_posts)
    lines.extend([
        "## 1. Overview",
        "",
        f"| Metric | Count |",
        f"|--------|-------|",
        f"| Influencer posts | {total_posts} |",
        f"| Market signals | {total_signals} |",
        f"| Topics tracked | {len(market_topics)} |",
        f"| Transcripts available | {len(transcript_excerpts)} |",
        f"| Pain signals detected | {len(pain_signals)} |",
        f"| Convergent topics | {len(convergences)} |",
        f"| Top post views | {total_views:,} |",
        "",
        "---",
        "",
    ])

    lines.extend([
        "## 2. Influencer Activity",
        "",
        "| Handle | Platform | Posts | Views | Likes | Comments |",
        "|--------|----------|-------|-------|-------|----------|",
    ])
    for inf in influencers:
        lines.append(
            f"| @{inf['handle']} | {inf['platform']} | {inf['post_count']} | "
            f"{inf.get('total_views', 0):,} | {inf.get('total_likes', 0):,} | {inf.get('total_comments', 0):,} |"
        )
    lines.extend(["", "---", ""])

    lines.extend([
        "## 3. Top Posts (by views)",
        "",
    ])
    for i, p in enumerate(top_posts[:10], 1):
        title = (p.get("content") or "Untitled")[:80]
        transcript_tag = " [HAS TRANSCRIPT]" if p.get("has_transcript") else ""
        lines.extend([
            f"### {i}. @{p['handle']} ({p['platform']}){transcript_tag}",
            f"**Views:** {p.get('views', 0):,} | **Likes:** {p.get('likes', 0):,} | **Comments:** {p.get('comments_count', 0):,}",
            f"**Title:** {title}",
            "",
        ])
    lines.extend(["---", ""])

    if transcript_excerpts:
        lines.extend([
            "## 4. Key Transcript Quotes (auto-extracted)",
            "",
            "*Extracted by keyword matching -- not AI-curated. Focus on pain-indicating and insight-containing sentences.*",
            "",
        ])
        for ex in transcript_excerpts[:8]:
            lines.append(f"**@{ex['handle']}** ({ex.get('views', 0):,} views) — {ex['title']}")
            for q in ex["quotes"]:
                lines.append(f"> \"{q.strip()}\"")
            lines.append("")
        lines.extend(["---", ""])

    lines.extend([
        "## 5. Market Signal Topics (ranked by engagement)",
        "",
        "| Topic | Signals | Views | Likes | Platforms |",
        "|-------|---------|-------|-------|-----------|",
    ])
    for t in market_topics[:15]:
        lines.append(
            f"| {(t.get('topic') or '?')[:50]} | {t.get('signal_count', 0)} | "
            f"{t.get('total_views', 0):,} | {t.get('total_likes', 0):,} | {t.get('platform_list', '')} |"
        )
    lines.extend(["", "---", ""])

    if pain_signals:
        lines.extend([
            "## 6. Pain Signals (pre-filtered by keywords)",
            "",
            "*These signals contain pain-indicating language. Sorted by engagement.*",
            "",
        ])
        for ps in pain_signals[:20]:
            content = (ps.get("content") or "")[:200]
            lines.extend([
                f"- **@{ps.get('author', '?')}** ({ps['platform']}, {ps.get('likes', 0)} likes): {content}",
                f"  Topic: {ps.get('topic', '?')}",
                "",
            ])
        lines.extend(["---", ""])

    if convergences:
        lines.extend([
            "## 7. Convergent Topics (influencer + market agree)",
            "",
            "*Topics where both tracked influencers AND broader market signals discuss the same theme.*",
            "",
            "| Topic | Market Signals | Market Views | Overlap Score | Platforms |",
            "|-------|---------------|-------------|---------------|-----------|",
        ])
        for c in convergences:
            lines.append(
                f"| {(c['topic'] or '?')[:50]} | {c['market_signals']} | "
                f"{c.get('market_views', 0):,} | {c['influencer_overlap_score']} | {c.get('platforms', '')} |"
            )
        lines.extend(["", "---", ""])

    if top_comments:
        lines.extend([
            "## 8. Audience Voice (top comments by likes)",
            "",
            "*Direct audience reactions -- useful for pain point validation and content hooks.*",
            "",
        ])
        for c in top_comments[:15]:
            content = (c.get("content") or "")[:200]
            lines.append(f"- **@{c.get('author', '?')}** ({c.get('likes', 0)} likes, on @{c.get('post_author', '?')}'s post): \"{content}\"")
        lines.extend(["", "---", ""])

    if asset_matches:
        lines.extend([
            "## 9. Brand Asset Matches (pre-computed)",
            "",
            "| Topic | Matched Asset |",
            "|-------|---------------|",
        ])
        for topic, asset in asset_matches.items():
            lines.append(f"| {topic[:50]} | {asset} |")
        lines.extend(["", "---", ""])

    if mode == "strategist" and finding_persistence:
        lines.extend([
            "## 10. Finding Persistence (multi-week tracking)",
            "",
            "*Topics that appear across multiple days = strong signals. Core input for opportunity scoring.*",
            "",
            "| Topic | Type | Days Appeared | First Seen | Last Seen | Peak Engagement | Signal |",
            "|-------|------|--------------|------------|-----------|-----------------|--------|",
        ])
        for fp in finding_persistence[:20]:
            lines.append(
                f"| {(fp['title'] or '?')[:45]} | {fp.get('type', '?')} | "
                f"**{fp.get('days_appeared', 0)}** | {fp.get('first_seen', '?')} | {fp.get('last_seen', '?')} | "
                f"{fp.get('peak_engagement', 0):,} | {fp.get('signal_strength', '?')} |"
            )
        lines.extend(["", "---", ""])

    if mode == "strategist" and opp_evolution:
        lines.extend([
            "## 11. Opportunity Evolution",
            "",
            "| Category | Title | Priority | Status | Finding | Created |",
            "|----------|-------|----------|--------|---------|---------|",
        ])
        for o in opp_evolution[:15]:
            lines.append(
                f"| {o.get('category', '?')} | {(o.get('title') or '?')[:40]} | "
                f"{o.get('priority', '?')} | {o.get('status', '?')} | {(o.get('finding_title') or '')[:30]} | {o.get('created', '?')} |"
            )
        lines.extend(["", "---", ""])

    lines.extend([
        f"*Data pack generated: {DATE} by weekly_prep.py*",
        f"*Read this file instead of querying the DB. Focus your budget on analysis and writing.*",
    ])

    return "\n".join(lines)


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Weekly data prep — pre-process for AI agents")
    parser.add_argument("--lookback-days", type=int, default=7, help="Lookback window (default: 7)")
    parser.add_argument("--for", dest="mode", choices=["miner", "strategist"], default="miner",
                        help="Who is this for? (miner=weekly analysis, strategist=multi-week patterns)")
    args = parser.parse_args()

    start_time = time.time()
    log(f"Weekly prep starting — {DATE}")

    if not DB_PATH.exists():
        log("[ERROR] No database found")
        sys.exit(1)

    data_pack = generate_data_pack(args.lookback_days, args.mode)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    prep_dir = REPORTS_DIR / "_prep"
    prep_dir.mkdir(parents=True, exist_ok=True)
    suffix = "strategist" if args.mode == "strategist" else "weekly"
    output_path = prep_dir / f"{DATE}-{suffix}-data-pack.md"
    output_path.write_text(data_pack)

    elapsed = int(time.time() - start_time)
    line_count = len(data_pack.splitlines())

    log("=" * 40)
    log(f"Data pack ready — {elapsed}s, {line_count} lines")
    log(f"  Saved: {output_path}")
    log("=" * 40)

    print(json.dumps({
        "date": DATE,
        "mode": args.mode,
        "lookback_days": args.lookback_days,
        "output_path": str(output_path),
        "lines": line_count,
        "elapsed_seconds": elapsed,
    }))


if __name__ == "__main__":
    main()
