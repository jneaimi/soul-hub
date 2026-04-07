#!/usr/bin/env python3
"""engagement-ranker — Rank posts by engagement, output top N as markdown."""
import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
DB_PATH = PIPELINE_DIR / "db" / "data.db"
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", str(PIPELINE_DIR / "output" / "top-10-trending.md"))
TOP_N = int(os.environ.get("BLOCK_CONFIG_TOP_N", "10"))
DATE = datetime.now().strftime("%Y-%m-%d")


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def truncate(text: str, length: int = 60) -> str:
    if not text:
        return "(no title)"
    text = text.replace("\n", " ").strip()
    return text[:length] + "..." if len(text) > length else text


def main():
    if not DB_PATH.exists():
        log(f"[ERROR] Database not found: {DB_PATH}")
        print(json.dumps({"error": "database not found"}))
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT
            p.content,
            p.url,
            i.handle,
            i.platform,
            p.likes,
            p.comments_count,
            p.shares,
            p.views,
            (p.likes + p.comments_count + p.shares) AS total_engagement
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE p.fetched_at >= datetime('now', '-1 day')
        ORDER BY total_engagement DESC
        LIMIT ?
    """, (TOP_N,)).fetchall()

    conn.close()

    if not rows:
        log("[WARN] No posts found in the last 24h")
        report = f"# Top {TOP_N} Trending Posts — {DATE}\n\nNo posts found in the last 24 hours.\n"
    else:
        lines = [
            f"# Top {TOP_N} Trending Posts — {DATE}\n",
            f"| # | Title | Platform | Author | Likes | Comments | Shares | Total |",
            f"|---|-------|----------|--------|------:|----------:|-------:|------:|",
        ]
        for i, row in enumerate(rows, 1):
            title = truncate(row["content"])
            # Escape pipes in title for markdown table
            title = title.replace("|", "\\|")
            platform = row["platform"]
            author = f"@{row['handle']}"
            likes = row["likes"] or 0
            comments = row["comments_count"] or 0
            shares = row["shares"] or 0
            total = row["total_engagement"] or 0
            lines.append(f"| {i} | {title} | {platform} | {author} | {likes:,} | {comments:,} | {shares:,} | {total:,} |")

        report = "\n".join(lines) + "\n"

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        f.write(report)

    log(f"[OK] Report written: {OUTPUT_PATH} ({len(rows)} posts)")
    print(json.dumps({
        "date": DATE,
        "posts_ranked": len(rows),
        "output": OUTPUT_PATH,
    }))


if __name__ == "__main__":
    main()
