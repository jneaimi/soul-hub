#!/usr/bin/env python3
"""title-ranker — Rank posts by total engagement, output top N titles."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from json_config import read_config
from output_writer import write_output
from progress import report_progress, report_status

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")
SETTINGS_PATH = PIPELINE_DIR / "config" / "pipeline-settings.json"


def get_setting(settings, key, default=""):
    for s in settings:
        if s.get("setting") == key:
            return s.get("value", default)
    return default


def main():
    report_status("Loading posts and settings")

    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        write_output({"status": "error", "message": "No input from scan-posts", "top_titles": []})
        return

    with open(INPUT_PATH) as f:
        data = json.load(f)

    posts = data.get("posts", [])
    if not posts:
        write_output({
            "status": "no_posts",
            "message": "No posts to rank",
            "top_titles": [],
            "warnings": data.get("warnings", []),
        })
        return

    settings = read_config(SETTINGS_PATH)
    top_n = int(get_setting(settings, "top_n", "3"))

    report_progress(30, f"Ranking {len(posts)} posts by engagement")

    # Sort by total_engagement descending
    ranked = sorted(posts, key=lambda p: p.get("total_engagement", 0), reverse=True)

    # Deduplicate by title (keep highest engagement version)
    seen_titles = set()
    unique_ranked = []
    for post in ranked:
        title_key = (post.get("title", "") or "").strip().lower()
        if title_key and title_key not in seen_titles:
            seen_titles.add(title_key)
            unique_ranked.append(post)
        elif not title_key:
            unique_ranked.append(post)

    top_titles = []
    for rank, post in enumerate(unique_ranked[:top_n], 1):
        top_titles.append({
            "rank": rank,
            "title": post.get("title", ""),
            "platform": post.get("platform", ""),
            "influencer_name": post.get("influencer_name", ""),
            "handle": post.get("handle", ""),
            "total_engagement": post.get("total_engagement", 0),
            "likes": post.get("likes", 0),
            "comments": post.get("comments", 0),
            "shares": post.get("shares", 0),
            "views": post.get("views", 0),
            "url": post.get("url", ""),
            "published_at": post.get("published_at", ""),
        })

    report_progress(80, f"Selected top {len(top_titles)} titles")

    result = {
        "status": "ok",
        "total_posts_analyzed": len(posts),
        "top_n_requested": top_n,
        "top_titles": top_titles,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    write_output(result)
    report_progress(100, f"Done — top {len(top_titles)} titles ranked")

    # Print summary for logs
    for t in top_titles:
        print(f"  #{t['rank']}: [{t['platform']}] {t['title'][:80]} — {t['total_engagement']} engagement")


if __name__ == "__main__":
    with_error_handling(main)()
