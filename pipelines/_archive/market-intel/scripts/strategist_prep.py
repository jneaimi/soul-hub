#!/usr/bin/env python3
"""strategist_prep.py — Pre-process multi-week findings for the Strategist.

Pre-computes patterns, persistence, clustering, convergence, and asset matches
so the AI agent focuses purely on opportunity scoring and writing.

Usage:
    python3 strategist_prep.py                        # Standard (4 weeks)
    python3 strategist_prep.py --lookback-weeks 6     # Wider window
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
STRATEGIST_CONFIG = MI_CONFIG / "strategist-config.md"
DATE = MI_DATE


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ──────────────────────────────────────────────
# Title normalization
# ──────────────────────────────────────────────

def _normalize(title: str) -> str:
    t = title.lower().strip()
    t = re.sub(r"\*\*", "", t)
    t = t.strip('"').strip("'")
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


# ──────────────────────────────────────────────
# Pattern A: Persistent Pain
# ──────────────────────────────────────────────

def detect_persistent_pain(db, lookback_days: int, min_days: int = 3) -> list[dict]:
    rows = db.execute("""
        SELECT title, description, signal_strength, pillar,
               COUNT(*) as appearances,
               COUNT(DISTINCT date(created_at)) as days_seen,
               MIN(date(created_at)) as first_seen,
               MAX(date(created_at)) as last_seen,
               MAX(engagement_total) as peak_engagement,
               MAX(source_count) as max_sources
        FROM findings
        WHERE type = 'pain_point'
          AND created_at >= datetime('now', ? || ' days')
        GROUP BY title
        HAVING days_seen >= ?
        ORDER BY days_seen DESC, peak_engagement DESC
    """, (f"-{lookback_days}", min_days)).fetchall()

    results = [dict(r) for r in rows]

    all_pain = db.execute("""
        SELECT title, description, signal_strength,
               COUNT(DISTINCT date(created_at)) as days_seen,
               MAX(engagement_total) as peak_engagement
        FROM findings
        WHERE type = 'pain_point'
          AND created_at >= datetime('now', ? || ' days')
        GROUP BY title
        ORDER BY days_seen DESC
    """, (f"-{lookback_days}",)).fetchall()

    clusters = []
    for pain in all_pain:
        norm = _normalize(pain["title"])
        placed = False
        for cluster in clusters:
            if _words_overlap(norm, _normalize(cluster[0]["title"])) >= 0.5:
                cluster.append(dict(pain))
                placed = True
                break
        if not placed:
            clusters.append([dict(pain)])

    pain_clusters = [c for c in clusters if len(c) >= 3]

    return results, pain_clusters


# ──────────────────────────────────────────────
# Pattern B: Convergence
# ──────────────────────────────────────────────

def detect_convergence(db, lookback_days: int) -> list[dict]:
    posts = db.execute("""
        SELECT i.handle, p.content, p.views
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', ? || ' days')
        ORDER BY p.views DESC
    """, (f"-{lookback_days}",)).fetchall()

    market = db.execute("""
        SELECT ms.topic, COUNT(*) as signal_count,
               SUM(sig.views) as total_views, SUM(sig.likes) as total_likes,
               COUNT(DISTINCT sig.platform) as platforms
        FROM market_signals sig
        JOIN market_searches ms ON sig.search_id = ms.id
        WHERE sig.fetched_at >= datetime('now', ? || ' days')
        GROUP BY ms.topic
        ORDER BY signal_count DESC
    """, (f"-{lookback_days}",)).fetchall()

    findings = db.execute("""
        SELECT title, signal_strength, source_count, engagement_total,
               COUNT(DISTINCT date(created_at)) as days_seen
        FROM findings
        WHERE created_at >= datetime('now', ? || ' days')
        GROUP BY title
        ORDER BY days_seen DESC
    """, (f"-{lookback_days}",)).fetchall()

    post_keywords = defaultdict(int)
    for p in posts:
        for word in re.findall(r'\b[a-z]{4,}\b', (p["content"] or "").lower()):
            post_keywords[word] += 1

    convergences = []
    for topic in market:
        topic_name = topic["topic"] or ""
        topic_words = set(re.findall(r'\b[a-z]{4,}\b', topic_name.lower()))
        overlap = sum(post_keywords.get(w, 0) for w in topic_words)

        finding_match = None
        for f in findings:
            if _words_overlap(_normalize(topic_name), _normalize(f["title"])) >= 0.5:
                finding_match = dict(f)
                break

        if overlap >= 2 or finding_match:
            convergences.append({
                "topic": topic_name,
                "market_signals": topic["signal_count"],
                "market_views": topic["total_views"] or 0,
                "market_likes": topic["total_likes"] or 0,
                "platforms": topic["platforms"],
                "influencer_overlap": overlap,
                "finding_match": finding_match,
            })

    convergences.sort(key=lambda x: -(x["influencer_overlap"] + (3 if x["finding_match"] else 0)))
    return convergences[:15]


# ──────────────────────────────────────────────
# Pattern D: Asset-Market Fit
# ──────────────────────────────────────────────

def detect_asset_fit(db, lookback_days: int) -> list[dict]:
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
        if name and topics:
            assets.append({"name": name, "topics": topics, "cta_en": cta_en, "cta_ar": cta_ar})

    findings = db.execute("""
        SELECT f.title, f.type, f.signal_strength, f.engagement_total,
               f.source_count, ms.relevance as gcc_relevance,
               COUNT(DISTINCT date(f.created_at)) as days_seen
        FROM findings f
        LEFT JOIN market_scores ms ON f.id = ms.finding_id AND ms.market = 'gcc'
        WHERE f.created_at >= datetime('now', ? || ' days')
        GROUP BY f.title
        ORDER BY days_seen DESC, f.engagement_total DESC
    """, (f"-{lookback_days}",)).fetchall()

    fits = []
    for asset in assets:
        for f in findings:
            title_lower = (f["title"] or "").lower()
            overlap = sum(1 for t in asset["topics"] if t in title_lower)
            if overlap >= 2:
                fits.append({
                    "asset_name": asset["name"],
                    "asset_topics": asset["topics"],
                    "finding_title": f["title"],
                    "finding_type": f["type"],
                    "signal_strength": f["signal_strength"],
                    "gcc_relevance": f["gcc_relevance"] or "unknown",
                    "days_seen": f["days_seen"],
                    "engagement": f["engagement_total"] or 0,
                    "keyword_overlap": overlap,
                    "cta_en": asset.get("cta_en", ""),
                    "cta_ar": asset.get("cta_ar", ""),
                })

    fits.sort(key=lambda x: -(x["keyword_overlap"] + x["days_seen"]))
    return fits


# ──────────────────────────────────────────────
# Opportunity evolution
# ──────────────────────────────────────────────

def get_opportunity_history(db, lookback_days: int) -> list[dict]:
    rows = db.execute("""
        SELECT o.category, o.title, o.description, o.priority, o.status,
               f.title as finding_title, f.signal_strength, f.engagement_total,
               date(o.created_at) as created
        FROM opportunities o
        JOIN findings f ON o.finding_id = f.id
        WHERE o.created_at >= datetime('now', ? || ' days')
        ORDER BY o.created_at DESC
    """, (f"-{lookback_days}",)).fetchall()
    return [dict(r) for r in rows]


def get_previous_strategist_report() -> Path | None:
    reports = sorted(REPORTS_DIR.glob("*-strategist-weekly.md"), reverse=True)
    return reports[0] if reports else None


# ──────────────────────────────────────────────
# Pre-score opportunities
# ──────────────────────────────────────────────

def pre_score_patterns(persistent_pains, pain_clusters, convergences, asset_fits, lookback_weeks) -> list[dict]:
    candidates = []
    seen_titles = set()

    for p in persistent_pains:
        title = p["title"]
        if _normalize(title) in seen_titles:
            continue
        seen_titles.add(_normalize(title))

        weeks = p.get("days_seen", 1) / 5
        persistence_score = 3 if weeks >= 3 else (2 if weeks >= 2 else 1)
        engagement = p.get("peak_engagement", 0) or 0
        market_score = 3 if engagement > 100000 else (2 if engagement > 10000 else 1)

        asset_match = None
        for af in asset_fits:
            if _words_overlap(_normalize(title), _normalize(af["finding_title"])) >= 0.5:
                asset_match = af
                break
        brand_score = 3 if asset_match else 0

        candidates.append({
            "title": title,
            "pattern": "persistent_pain",
            "description": p.get("description", ""),
            "days_seen": p.get("days_seen", 1),
            "first_seen": p.get("first_seen"),
            "last_seen": p.get("last_seen"),
            "engagement": engagement,
            "signal_strength": p.get("signal_strength", "medium"),
            "pre_scores": {
                "pain_persistence": persistence_score,
                "market_size": market_score,
                "brand_leverage": brand_score,
                "competitive_gap": "AI_JUDGE",
                "time_to_revenue": "AI_JUDGE",
                "effort_to_execute": "AI_JUDGE",
            },
            "partial_score": (persistence_score * 3) + (market_score * 3) + (brand_score * 2),
            "max_possible": 36,
            "asset_match": asset_match["asset_name"] if asset_match else None,
        })

    for c in convergences:
        title = c["topic"]
        norm = _normalize(title)
        if norm in seen_titles:
            continue
        seen_titles.add(norm)

        engagement = c.get("market_views", 0) or 0
        market_score = 3 if engagement > 100000 else (2 if engagement > 10000 else 1)
        days_seen = c["finding_match"]["days_seen"] if c.get("finding_match") else 1
        persistence_score = 3 if days_seen >= 15 else (2 if days_seen >= 10 else 1)

        candidates.append({
            "title": title,
            "pattern": "convergence",
            "description": f"Influencer + market signals align ({c['market_signals']} signals, {c['platforms']} platforms)",
            "days_seen": days_seen,
            "market_signals": c["market_signals"],
            "engagement": engagement,
            "signal_strength": c["finding_match"]["signal_strength"] if c.get("finding_match") else "medium",
            "pre_scores": {
                "pain_persistence": persistence_score,
                "market_size": market_score,
                "brand_leverage": "AI_JUDGE",
                "competitive_gap": "AI_JUDGE",
                "time_to_revenue": "AI_JUDGE",
                "effort_to_execute": "AI_JUDGE",
            },
            "partial_score": (persistence_score * 3) + (market_score * 3),
            "max_possible": 36,
        })

    for cluster in pain_clusters:
        cluster_title = cluster[0]["title"]
        norm = _normalize(cluster_title)
        if norm in seen_titles:
            continue
        seen_titles.add(norm)

        total_engagement = sum(c.get("peak_engagement", 0) or 0 for c in cluster)
        max_days = max(c.get("days_seen", 1) for c in cluster)

        candidates.append({
            "title": f"Pain cluster: {cluster_title} (+{len(cluster)-1} related)",
            "pattern": "pain_cluster",
            "description": f"{len(cluster)} related pain points",
            "cluster_members": [c["title"] for c in cluster],
            "days_seen": max_days,
            "engagement": total_engagement,
            "pre_scores": {
                "pain_persistence": 3,
                "market_size": 3 if total_engagement > 100000 else 2,
                "brand_leverage": "AI_JUDGE",
                "competitive_gap": "AI_JUDGE",
                "time_to_revenue": "AI_JUDGE",
                "effort_to_execute": "AI_JUDGE",
            },
            "partial_score": 9 + (3 if total_engagement > 100000 else 2) * 3,
        })

    for af in asset_fits:
        norm = _normalize(af["finding_title"])
        if norm in seen_titles:
            continue
        seen_titles.add(norm)

        candidates.append({
            "title": f"Asset fit: {af['asset_name']} x {af['finding_title'][:40]}",
            "pattern": "asset_market_fit",
            "description": f"Brand asset '{af['asset_name']}' matches finding with {af['keyword_overlap']} keyword overlap",
            "asset_name": af["asset_name"],
            "finding_title": af["finding_title"],
            "gcc_relevance": af["gcc_relevance"],
            "days_seen": af["days_seen"],
            "engagement": af["engagement"],
            "pre_scores": {
                "pain_persistence": 2 if af["days_seen"] >= 5 else 1,
                "market_size": 2,
                "brand_leverage": 3,
                "competitive_gap": "AI_JUDGE",
                "time_to_revenue": 3,
                "effort_to_execute": 3,
            },
            "partial_score": (2 * 3) + (2 * 3) + (3 * 2) + 3 + 3,
        })

    candidates.sort(key=lambda x: -x.get("partial_score", 0))
    return candidates


# ──────────────────────────────────────────────
# Generate prep
# ──────────────────────────────────────────────

def generate_prep(lookback_weeks: int) -> str:
    lookback_days = lookback_weeks * 7
    db = get_db()

    log("Detecting persistent pain points...")
    persistent_pains, pain_clusters = detect_persistent_pain(db, lookback_days)

    log("Detecting convergences (influencer x market)...")
    convergences = detect_convergence(db, lookback_days)

    log("Detecting asset-market fits...")
    asset_fits = detect_asset_fit(db, lookback_days)

    log("Getting opportunity history...")
    opp_history = get_opportunity_history(db, lookback_days)

    log("Pre-scoring candidates...")
    candidates = pre_score_patterns(persistent_pains, pain_clusters, convergences, asset_fits, lookback_weeks)

    prev_report = get_previous_strategist_report()

    db.close()

    lines = [
        "---",
        "type: strategist-prep",
        f"created: {DATE}",
        f"lookback_weeks: {lookback_weeks}",
        "tags: [market-intel, strategist-prep]",
        "---",
        "",
        f"# Strategist Prep — {DATE}",
        "",
        f"**Pre-processed by:** strategist_prep.py (Python, no AI)",
        f"**Lookback:** {lookback_weeks} weeks ({lookback_days} days)",
        f"**Candidates found:** {len(candidates)}",
        f"**Persistent pains:** {len(persistent_pains)} | **Pain clusters:** {len(pain_clusters)} | **Convergences:** {len(convergences)} | **Asset fits:** {len(asset_fits)}",
        "",
        "**YOUR JOB:** Read this prep and produce the Business Opportunity Brief.",
        "- Pre-computed scores are provided for deterministic factors",
        "- Score factors marked `AI_JUDGE` require your analysis",
        "- Assign a category (product/service/training/partnership/brand/community)",
        "- Write evidence-backed narrative + first steps for ACT NOW items",
        "",
        "---",
        "",
    ]

    lines.extend([
        "## 1. Opportunity Candidates (pre-scored)",
        "",
        "| # | Pattern | Title | Days | Engagement | Pre-Score | Needs AI |",
        "|---|---------|-------|------|------------|-----------|----------|",
    ])
    for i, c in enumerate(candidates[:15], 1):
        ai_needed = sum(1 for v in c["pre_scores"].values() if v == "AI_JUDGE")
        lines.append(
            f"| {i} | {c['pattern']} | {c['title'][:50]} | {c.get('days_seen', '?')} | "
            f"{c.get('engagement', 0):,} | **{c.get('partial_score', 0)}/36** | {ai_needed} factors |"
        )
    lines.extend(["", "---", ""])

    for i, c in enumerate(candidates[:10], 1):
        lines.extend([
            f"## Candidate {i:02d} — {c['title'][:60]}",
            f"**Pattern:** {c['pattern']} | **Days seen:** {c.get('days_seen', '?')} | **Engagement:** {c.get('engagement', 0):,}",
            "",
        ])

        if c.get("description"):
            lines.append(f"**Description:** {c['description']}")
            lines.append("")

        if c.get("cluster_members"):
            lines.append("**Cluster members:**")
            for member in c["cluster_members"][:5]:
                lines.append(f"- {member}")
            lines.append("")

        if c.get("asset_match") or c.get("asset_name"):
            asset = c.get("asset_match") or c.get("asset_name")
            lines.append(f"**Brand asset match:** {asset}")
            lines.append("")

        lines.append("**Pre-computed scores:**")
        lines.append("| Factor | Weight | Score | Notes |")
        lines.append("|--------|--------|-------|-------|")
        for factor, score in c["pre_scores"].items():
            weight = {"pain_persistence": "x3", "market_size": "x3", "competitive_gap": "x2",
                      "brand_leverage": "x2", "time_to_revenue": "x1", "effort_to_execute": "x1"}[factor]
            if score == "AI_JUDGE":
                lines.append(f"| {factor} | {weight} | **?** | *Your judgment needed* |")
            else:
                lines.append(f"| {factor} | {weight} | {score}/3 | Pre-computed |")

        lines.append(f"\n**Partial score:** {c.get('partial_score', 0)}/36 (+ AI factors)")
        lines.extend(["", "---", ""])

    if persistent_pains:
        lines.extend([
            "## 3. Persistent Pain Points (Pattern A)",
            "",
            "| Pain Point | Days | First Seen | Last Seen | Engagement | Signal |",
            "|------------|------|------------|-----------|------------|--------|",
        ])
        for p in persistent_pains[:10]:
            lines.append(
                f"| {(p['title'] or '?')[:45]} | **{p['days_seen']}** | {p.get('first_seen', '?')} | "
                f"{p.get('last_seen', '?')} | {(p.get('peak_engagement') or 0):,} | {p.get('signal_strength', '?')} |"
            )
        lines.extend(["", "---", ""])

    if pain_clusters:
        lines.extend([
            "## 4. Pain Clusters (Pattern C)",
            "",
        ])
        for i, cluster in enumerate(pain_clusters[:5], 1):
            lines.append(f"### Cluster {i}: {cluster[0]['title'][:50]} ({len(cluster)} related)")
            for c in cluster:
                lines.append(f"- {c['title']} (seen {c.get('days_seen', '?')} days)")
            lines.append("")
        lines.extend(["---", ""])

    if convergences:
        lines.extend([
            "## 5. Convergent Topics (Pattern B)",
            "",
            "| Topic | Market Signals | Views | Platforms | Finding Match |",
            "|-------|---------------|-------|-----------|---------------|",
        ])
        for c in convergences[:10]:
            finding = c["finding_match"]["title"][:30] if c.get("finding_match") else "—"
            lines.append(
                f"| {(c['topic'] or '?')[:40]} | {c['market_signals']} | {c.get('market_views', 0):,} | "
                f"{c['platforms']} | {finding} |"
            )
        lines.extend(["", "---", ""])

    if asset_fits:
        lines.extend([
            "## 6. Asset-Market Fits (Pattern D)",
            "",
            "| Asset | Finding | GCC | Overlap | Days |",
            "|-------|---------|-----|---------|------|",
        ])
        for af in asset_fits[:10]:
            lines.append(
                f"| {af['asset_name'][:25]} | {(af['finding_title'] or '?')[:30]} | "
                f"{af['gcc_relevance']} | {af['keyword_overlap']} | {af['days_seen']} |"
            )
        lines.extend(["", "---", ""])

    if opp_history:
        lines.extend([
            "## 7. Previous Opportunities (evolution tracking)",
            "",
            "| Category | Title | Priority | Status | Created |",
            "|----------|-------|----------|--------|---------|",
        ])
        for o in opp_history[:10]:
            lines.append(
                f"| {o.get('category', '?')} | {(o.get('title') or '?')[:40]} | "
                f"{o.get('priority', '?')} | {o.get('status', '?')} | {o.get('created', '?')} |"
            )
        lines.extend(["", "---", ""])

    if prev_report:
        lines.extend([
            "## 8. Previous Strategist Report",
            "",
            f"Read the previous report for evolution tracking: `{prev_report}`",
            "Compare: Did DEVELOP items gain evidence? Did WATCH items die? Any new ACT NOW?",
            "",
            "---",
            "",
        ])

    lines.extend([
        "## Output Instructions",
        "",
        f"Save the Business Opportunity Brief to: `{REPORTS_DIR}/{DATE}-strategist-weekly.md`",
        "",
        "For each candidate:",
        "1. Score the `AI_JUDGE` factors (competitive_gap, time_to_revenue, effort_to_execute, brand_leverage where needed)",
        "2. Add to the pre-computed partial score -> total score",
        "3. Classify: ACT NOW >= 24 | DEVELOP 16-23 | WATCH < 16",
        "4. Assign category: product / service / training / partnership / brand / community",
        "5. For ACT NOW: write evidence, revenue estimate, first step, risk",
        "6. For DEVELOP: write 1-2 sentence summary + what evidence would promote it",
        "7. For WATCH: one-line note",
    ])

    return "\n".join(lines)


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Strategist prep — pre-process for opportunity analysis")
    parser.add_argument("--lookback-weeks", type=int, default=4, help="Lookback window (default: 4 weeks)")
    args = parser.parse_args()

    start_time = time.time()
    log(f"Strategist prep starting — {DATE}")

    if not DB_PATH.exists():
        log("[ERROR] No database found")
        sys.exit(1)

    prep = generate_prep(args.lookback_weeks)

    prep_dir = REPORTS_DIR / "_prep"
    prep_dir.mkdir(parents=True, exist_ok=True)
    output_path = prep_dir / f"{DATE}-strategist-prep.md"
    output_path.write_text(prep)

    elapsed = int(time.time() - start_time)
    line_count = len(prep.splitlines())

    log("=" * 40)
    log(f"Strategist prep ready — {elapsed}s, {line_count} lines")
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
