#!/usr/bin/env python3
"""weekly-extractor — Extract last 7 days of data from DB for weekly analysis."""
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from output_writer import write_output
from progress import report_progress, report_status

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent)))
MODE = os.environ.get("BLOCK_CONFIG_MODE", "weekly")
DB_PATH = PIPELINE_DIR / "db" / "trends.db"


def dict_factory(cursor, row):
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def main():
    if MODE == "daily":
        report_status("Skipping weekly-extractor in daily mode")
        write_output({"status": "skipped", "mode": "daily"})
        return

    if not DB_PATH.exists():
        write_output({"status": "error", "message": "No database found — run daily mode first to accumulate data"})
        return

    report_status("Connecting to database")
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = dict_factory

    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")

    report_progress(10, "Querying weekly runs")
    runs = conn.execute(
        "SELECT * FROM runs WHERE started_at >= ? AND mode = 'daily' ORDER BY started_at DESC", (cutoff,)
    ).fetchall()

    if not runs:
        conn.close()
        write_output({
            "status": "no_data",
            "message": f"No daily runs found since {cutoff}",
            "weekly_summary": {},
        })
        return

    run_ids = [r["id"] for r in runs]
    placeholders = ",".join("?" * len(run_ids))

    report_progress(25, "Extracting posts")
    posts = conn.execute(
        f"SELECT influencer_name, platform, title, total_engagement, likes, comments, shares, views, url, published_at FROM posts WHERE run_id IN ({placeholders}) ORDER BY total_engagement DESC",
        run_ids
    ).fetchall()

    report_progress(40, "Extracting top titles")
    titles = conn.execute(
        f"SELECT rank, title, platform, influencer_name, total_engagement, likes, comments, shares, ranked_at FROM top_titles WHERE run_id IN ({placeholders}) ORDER BY ranked_at DESC",
        run_ids
    ).fetchall()

    report_progress(55, "Extracting trends")
    trends = conn.execute(
        f"SELECT search_query, platform, target_region, title, snippet, url, author, engagement_score, published_at FROM trends WHERE run_id IN ({placeholders}) ORDER BY engagement_score DESC",
        run_ids
    ).fetchall()

    report_progress(70, "Extracting comments")
    comments = conn.execute(
        f"SELECT platform, author, text, likes, reply_count, published_at FROM comments WHERE run_id IN ({placeholders}) AND is_spam = 0 ORDER BY likes DESC",
        run_ids
    ).fetchall()

    report_progress(85, "Extracting pain points")
    pain_points = conn.execute(
        f"SELECT theme, description, frequency, evidence_quotes, source_platforms, severity FROM pain_points WHERE run_id IN ({placeholders}) ORDER BY frequency DESC",
        run_ids
    ).fetchall()

    conn.close()

    # Aggregate stats
    platform_counts = {}
    influencer_counts = {}
    for post in posts:
        platform_counts[post["platform"]] = platform_counts.get(post["platform"], 0) + 1
        influencer_counts[post["influencer_name"]] = influencer_counts.get(post["influencer_name"], 0) + 1

    # Deduplicate titles across days
    unique_titles = {}
    for t in titles:
        key = t["title"].strip().lower()
        if key not in unique_titles or t["total_engagement"] > unique_titles[key]["total_engagement"]:
            unique_titles[key] = t
    deduped_titles = sorted(unique_titles.values(), key=lambda x: x["total_engagement"], reverse=True)

    # Recurring themes in titles
    title_words = {}
    for t in deduped_titles:
        for word in t["title"].lower().split():
            if len(word) > 3:
                title_words[word] = title_words.get(word, 0) + 1

    result = {
        "status": "ok",
        "period": {"from": cutoff, "to": datetime.now(timezone.utc).isoformat()},
        "daily_runs": len(runs),
        "summary": {
            "total_posts": len(posts),
            "total_trends": len(trends),
            "total_comments": len(comments),
            "total_pain_points": len(pain_points),
            "platforms": platform_counts,
            "influencers": influencer_counts,
        },
        "top_titles_this_week": deduped_titles[:10],
        "recurring_keywords": dict(sorted(title_words.items(), key=lambda x: x[1], reverse=True)[:20]),
        "top_trends": trends[:30],
        "top_comments": comments[:50],
        "pain_points_accumulated": pain_points,
        "all_posts_summary": [
            {"influencer": p["influencer_name"], "platform": p["platform"],
             "title": p["title"][:100], "engagement": p["total_engagement"]}
            for p in posts[:50]
        ],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    write_output(result)
    report_progress(100, f"Done — {len(runs)} daily runs, {len(posts)} posts, {len(comments)} comments extracted")


if __name__ == "__main__":
    with_error_handling(main)()
