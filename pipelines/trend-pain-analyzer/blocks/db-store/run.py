#!/usr/bin/env python3
"""db-store — Persist all pipeline data into SQLite for querying and weekly analysis."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from db_init import init_db
from error_handler import with_error_handling
from output_writer import write_output
from progress import report_progress, report_status

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent)))
MODE = os.environ.get("BLOCK_CONFIG_MODE", "daily")

# Multi-input: PIPELINE_INPUT_0..N
INPUT_COUNT = int(os.environ.get("PIPELINE_INPUT_COUNT", "1"))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")


def load_input(index):
    """Load a specific input file by index."""
    path = os.environ.get(f"PIPELINE_INPUT_{index}", "")
    if path and Path(path).exists():
        with open(path) as f:
            return json.load(f)
    return {}


def load_all_inputs():
    """Load all available inputs, trying multi-input first, then single."""
    inputs = {}
    if INPUT_COUNT > 1:
        for i in range(INPUT_COUNT):
            data = load_input(i)
            # Identify by content
            if "posts" in data and "influencers_scanned" in data:
                inputs["posts"] = data
            elif "top_titles" in data:
                inputs["titles"] = data
            elif "trends" in data:
                inputs["trends"] = data
            elif "comments" in data and "spam_filtered" in data:
                inputs["comments"] = data
    else:
        # Single input — try to load from known output paths
        output_dir = PIPELINE_DIR / "output"
        for name, filename in [
            ("posts", "scan-posts-result.json"),
            ("titles", "rank-titles-result.json"),
            ("trends", "trend-research-result.json"),
            ("comments", "collect-comments-result.json"),
        ]:
            path = output_dir / filename
            if path.exists():
                with open(path) as f:
                    inputs[name] = json.load(f)
    return inputs


def main():
    if MODE == "weekly":
        report_status("Skipping db-store in weekly mode")
        write_output({"status": "skipped", "mode": "weekly"})
        return

    report_status("Initializing database")
    conn = init_db(PIPELINE_DIR, "trends.db")
    conn.execute("PRAGMA foreign_keys = ON")

    # Ensure new columns exist on older DBs
    for col in ("lookback", "platforms_searched"):
        try:
            conn.execute(f"ALTER TABLE runs ADD COLUMN {col} TEXT")
        except Exception:
            pass  # Column already exists

    report_progress(10, "Loading step outputs")
    inputs = load_all_inputs()

    # Extract run metadata from trends output
    trends_meta = inputs.get("trends", {})
    lookback = trends_meta.get("lookback", "")
    platforms_searched = ",".join(trends_meta.get("active_platforms", []))

    # Create run record
    conn.execute(
        "INSERT INTO runs (mode, target_region, lookback, platforms_searched) VALUES (?, ?, ?, ?)",
        ("daily", trends_meta.get("target_region", ""), lookback, platforms_searched)
    )
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    counts = {"posts": 0, "top_titles": 0, "trends": 0, "comments": 0}

    # Insert posts
    report_progress(30, "Storing posts")
    posts_data = inputs.get("posts", {}).get("posts", [])
    for post in posts_data:
        conn.execute(
            """INSERT INTO posts (run_id, influencer_name, platform, handle, title, snippet,
               url, published_at, likes, comments, shares, views, total_engagement, raw_data)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, post.get("influencer_name", ""), post.get("platform", ""),
             post.get("handle", ""), post.get("title", ""), post.get("snippet", ""),
             post.get("url", ""), post.get("published_at", ""),
             post.get("likes", 0), post.get("comments", 0), post.get("shares", 0),
             post.get("views", 0), post.get("total_engagement", 0),
             post.get("raw_data", ""))
        )
        counts["posts"] += 1

    # Insert top titles
    report_progress(50, "Storing top titles")
    titles_data = inputs.get("titles", {}).get("top_titles", [])
    for title in titles_data:
        conn.execute(
            """INSERT INTO top_titles (run_id, rank, title, platform, influencer_name,
               total_engagement, likes, comments, shares)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, title.get("rank", 0), title.get("title", ""),
             title.get("platform", ""), title.get("influencer_name", ""),
             title.get("total_engagement", 0), title.get("likes", 0),
             title.get("comments", 0), title.get("shares", 0))
        )
        counts["top_titles"] += 1

    # Insert trends
    report_progress(70, "Storing trends")
    trends_data = inputs.get("trends", {}).get("trends", [])
    for trend in trends_data:
        conn.execute(
            """INSERT INTO trends (run_id, search_query, platform, target_region, title,
               snippet, url, author, engagement_score, published_at, raw_data)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, trend.get("search_query", ""), trend.get("platform", ""),
             trend.get("target_region", ""), trend.get("title", ""),
             trend.get("snippet", ""), trend.get("url", ""), trend.get("author", ""),
             trend.get("engagement_score", 0), trend.get("published_at", ""),
             trend.get("raw_data", ""))
        )
        counts["trends"] += 1

    # Insert comments
    report_progress(85, "Storing comments")
    comments_data = inputs.get("comments", {}).get("comments", [])
    for comment in comments_data:
        conn.execute(
            """INSERT INTO comments (run_id, platform, author, text, likes, reply_count,
               is_spam, published_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, comment.get("platform", ""), comment.get("author", ""),
             comment.get("text", ""), comment.get("likes", 0),
             comment.get("reply_count", 0), 1 if comment.get("is_spam") else 0,
             comment.get("published_at", ""))
        )
        counts["comments"] += 1

    # Mark run as completed
    conn.execute(
        "UPDATE runs SET completed_at = datetime('now'), status = 'completed' WHERE id = ?",
        (run_id,)
    )
    conn.commit()
    conn.close()

    result = {
        "status": "ok",
        "run_id": run_id,
        "rows_inserted": counts,
        "total_rows": sum(counts.values()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    write_output(result)
    report_progress(100, f"Done — stored {sum(counts.values())} rows (run #{run_id})")


if __name__ == "__main__":
    with_error_handling(main)()
