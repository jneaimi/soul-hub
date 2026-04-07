#!/usr/bin/env python3
"""scout_run.py — Deterministic Scout: fetch influencer posts and store in DB.

Usage:
    python3 scout_run.py                          # Standard run
    python3 scout_run.py --lookback-days 5        # Override lookback
    python3 scout_run.py --skip-comments          # Skip comment fetching
    python3 scout_run.py --skip-transcripts       # Skip transcript fetching
"""

import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from paths import MI_DB, MI_CONFIG, MI_DATE, MI_SCRIPTS

COLLECTOR = Path.home() / ".claude/skills/research/scripts/social_collector.py"
DB_SCRIPT = MI_SCRIPTS / "scout_db.py"
DB_PATH = MI_DB
ROSTER_PATH = MI_CONFIG / "influencer-roster.md"
TEMP_DIR = Path("/tmp/scout")
DATE = MI_DATE

PLATFORM_CMD = {
    "tiktok": lambda h: ["tiktok-search", h, "--sort", "most_recent", "--time-range", "1", "--pages", "1", "--compact"],
    "youtube": lambda h: ["youtube-search", h, "--upload-date", "today", "--pages", "1", "--compact"],
    "twitter": lambda h: ["twitter-tweets", h, "--pages", "1", "--compact"],
    "linkedin": lambda h: ["linkedin-search", h, "--sort", "most_recent", "--compact"],
    "instagram": lambda h: ["instagram-search", h, "--pages", "1", "--compact"],
    "reddit": lambda h: ["reddit-search", h, "--compact"],
}

COMMENT_PLATFORMS = {"youtube"}


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def run_cmd(cmd: list[str], timeout: int = 60, stdin_data: str | None = None) -> subprocess.CompletedProcess:
    """Run a command with timeout, return result."""
    return subprocess.run(
        cmd,
        input=stdin_data,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


# ──────────────────────────────────────────────
# Step 1: Parse roster
# ──────────────────────────────────────────────

def parse_roster() -> list[dict]:
    """Parse the influencer roster markdown table."""
    text = ROSTER_PATH.read_text()
    roster = []

    in_table = False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("| Handle"):
            in_table = True
            continue
        if in_table and line.startswith("| ---"):
            continue
        if in_table and line.startswith("|"):
            cols = [c.strip() for c in line.split("|")[1:-1]]
            if len(cols) >= 4:
                roster.append({
                    "handle": cols[0],
                    "platform": cols[1],
                    "focus": cols[2],
                    "why_follow": cols[3],
                })
        elif in_table and not line.startswith("|"):
            break

    return roster


def get_roster_config() -> dict:
    """Read config values from roster frontmatter."""
    text = ROSTER_PATH.read_text()
    config = {"lookback_days": 3}

    if "---" in text:
        fm = text.split("---")[1]
        m = re.search(r"lookback_days:\s*(\d+)", fm)
        if m:
            config["lookback_days"] = int(m.group(1))

    return config


# ──────────────────────────────────────────────
# Step 2: Sync roster to DB
# ──────────────────────────────────────────────

def sync_roster(roster: list[dict]) -> bool:
    """Write roster JSON and sync to DB."""
    roster_file = TEMP_DIR / "roster.json"
    roster_file.write_text(json.dumps(roster, indent=2))

    result = run_cmd(["uv", "run", str(DB_SCRIPT), "sync-roster", str(roster_file)])
    if result.returncode != 0:
        log(f"[ERROR] Roster sync failed: {result.stderr[:200]}")
        return False

    log(f"[OK] Roster synced ({len(roster)} influencers)")
    return True


# ──────────────────────────────────────────────
# Step 3: Fetch and ingest posts
# ──────────────────────────────────────────────

def fetch_and_ingest(roster: list[dict], lookback: int) -> dict:
    """Fetch posts for all influencers and ingest into DB."""
    stats = {"total": 0, "inserted": 0, "updated": 0, "errors": []}

    for i, inf in enumerate(roster, 1):
        handle = inf["handle"]
        platform = inf["platform"]

        cmd_args = PLATFORM_CMD.get(platform)
        if not cmd_args:
            log(f"[SKIP] {i}/{len(roster)} Unknown platform: {platform}")
            continue

        log(f"[STEP] {i}/{len(roster)} Fetching @{handle} on {platform}")

        safe_handle = handle.replace(" ", "_").replace("/", "_")
        outfile = TEMP_DIR / f"{safe_handle}_{platform}.json"

        try:
            fetch_cmd = ["uv", "run", str(COLLECTOR)] + cmd_args(handle)
            fetch = run_cmd(fetch_cmd, timeout=45)
        except subprocess.TimeoutExpired:
            err = f"@{handle} ({platform}): fetch timeout"
            log(f"  [TIMEOUT] {err}")
            stats["errors"].append(err)
            continue

        if fetch.returncode != 0:
            err = f"@{handle} ({platform}): fetch failed — {fetch.stderr[:100].strip()}"
            log(f"  [ERROR] {err}")
            stats["errors"].append(err)
            continue

        if not fetch.stdout.strip():
            log(f"  [WARN] @{handle}: empty response")
            stats["errors"].append(f"@{handle} ({platform}): empty response")
            continue

        outfile.write_text(fetch.stdout)

        try:
            ingest = run_cmd([
                "uv", "run", str(DB_SCRIPT), "ingest", str(outfile),
                "--handle", handle,
                "--platform", platform,
                "--lookback-days", str(lookback),
            ], timeout=30)
        except subprocess.TimeoutExpired:
            err = f"@{handle} ({platform}): ingest timeout"
            log(f"  [TIMEOUT] {err}")
            stats["errors"].append(err)
            continue

        if ingest.returncode == 0:
            try:
                r = json.loads(ingest.stdout)
                inserted = r.get("inserted", 0)
                updated = r.get("updated", 0)
                skipped_old = r.get("skipped_old", 0)
                skipped_author = r.get("skipped_author", 0)
                stats["inserted"] += inserted
                stats["updated"] += updated
                stats["total"] += inserted + updated
                log(f"  +{inserted} new, {updated} updated, {skipped_old} old, {skipped_author} noise")
            except json.JSONDecodeError:
                log(f"  [WARN] ingest output not JSON: {ingest.stdout[:100]}")
        else:
            err = f"@{handle} ({platform}): ingest failed — {ingest.stderr[:100].strip()}"
            log(f"  [ERROR] {err}")
            stats["errors"].append(err)

    return stats


# ──────────────────────────────────────────────
# Step 4: Fetch transcripts
# ──────────────────────────────────────────────

def fetch_transcripts() -> int:
    """Fetch YouTube transcripts for posts that don't have one."""
    log("[STEP] Fetching YouTube transcripts")
    try:
        result = run_cmd(
            ["uv", "run", str(DB_SCRIPT), "fetch-transcripts"],
            timeout=120,
        )
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                count = data.get("fetched", data.get("transcripts_fetched", 0))
                log(f"  Transcripts fetched: {count}")
                return count
            except (json.JSONDecodeError, AttributeError):
                log(f"  Transcripts done: {result.stdout.strip()[:100]}")
                return 0
        else:
            log(f"  [WARN] Transcript fetch failed: {result.stderr[:100]}")
            return 0
    except subprocess.TimeoutExpired:
        log("  [TIMEOUT] Transcript fetch exceeded 120s")
        return 0


# ──────────────────────────────────────────────
# Step 5: Fetch comments
# ──────────────────────────────────────────────

def fetch_comments(lookback: int) -> int:
    """Fetch YouTube comments for recent posts."""
    log("[STEP] Fetching YouTube comments")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT p.id, p.platform_post_id, i.handle, p.content,
               (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
        FROM posts p
        JOIN influencers i ON p.influencer_id = i.id
        WHERE i.platform = 'youtube'
          AND p.fetched_at >= datetime('now', ? || ' days')
          AND p.platform_post_id IS NOT NULL
          AND p.platform_post_id != ''
        ORDER BY p.fetched_at DESC
    """, (f"-{lookback}",)).fetchall()

    conn.close()

    to_fetch = [r for r in rows if r["comment_count"] < 5]

    if not to_fetch:
        log("  No posts need comments")
        return 0

    total_comments = 0
    for row in to_fetch:
        post_id = row["id"]
        raw_id = row["platform_post_id"]
        handle = row["handle"]

        video_id = raw_id
        if "watch?v=" in raw_id:
            video_id = raw_id.split("watch?v=")[1].split("&")[0]
        elif "youtu.be/" in raw_id:
            video_id = raw_id.split("youtu.be/")[1].split("?")[0]

        log(f"  Fetching comments for @{handle} ({video_id})")

        try:
            fetch = run_cmd([
                "uv", "run", str(COLLECTOR),
                "yt-comments",
                "--pages", "1",
                "--order", "relevance",
                "--compact",
                "--", video_id,
            ], timeout=30)
        except subprocess.TimeoutExpired:
            log(f"    [TIMEOUT] Comment fetch for {video_id}")
            continue

        if fetch.returncode != 0:
            log(f"    [ERROR] {fetch.stderr[:80].strip()}")
            continue

        try:
            data = json.loads(fetch.stdout)
            raw_comments = data.get("results", data.get("comments", []))
        except json.JSONDecodeError:
            log("    [WARN] Invalid JSON response")
            continue

        comments = []
        spam_words = ["subscribe", "follow me", "check my", "visit my", "click here"]
        for c in raw_comments:
            text = c.get("text", c.get("content", c.get("snippet", "")))
            if not text or len(text.split()) < 5:
                continue
            if any(w in text.lower() for w in spam_words):
                continue
            comments.append({
                "author": c.get("author", c.get("username", "unknown")),
                "content": text,
                "likes": int(c.get("likes", c.get("like_count", 0)) or 0),
            })

        if not comments:
            log("    No quality comments found")
            continue

        payload = json.dumps({"post_id": post_id, "comments": comments})
        try:
            insert = run_cmd(
                ["uv", "run", str(DB_SCRIPT), "insert-comments", "-"],
                timeout=15,
                stdin_data=payload,
            )
            if insert.returncode == 0:
                log(f"    Stored {len(comments)} comments")
                total_comments += len(comments)
            else:
                log(f"    [ERROR] Insert failed: {insert.stderr[:80]}")
        except subprocess.TimeoutExpired:
            log(f"    [TIMEOUT] Comment insert for {video_id}")

    return total_comments


# ──────────────────────────────────────────────
# Step 6: Summary
# ──────────────────────────────────────────────

def get_summary() -> dict:
    """Get DB summary stats."""
    try:
        result = run_cmd(["uv", "run", str(DB_SCRIPT), "summary"], timeout=15)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception:
        pass
    return {}


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scout — deterministic influencer post fetcher")
    parser.add_argument("--lookback-days", type=int, default=None, help="Override lookback days")
    parser.add_argument("--skip-comments", action="store_true", help="Skip comment fetching")
    parser.add_argument("--skip-transcripts", action="store_true", help="Skip transcript fetching")
    args = parser.parse_args()

    start_time = time.time()
    log(f"Scout run starting — {DATE}")

    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    if not DB_PATH.exists():
        log("[INIT] Creating database")
        run_cmd(["uv", "run", str(DB_SCRIPT), "init"])

    roster = parse_roster()
    config = get_roster_config()
    lookback = args.lookback_days or config["lookback_days"]
    log(f"Roster: {len(roster)} influencers | Lookback: {lookback}d")

    if not sync_roster(roster):
        log("[ABORT] Roster sync failed")
        sys.exit(1)

    ingest_stats = fetch_and_ingest(roster, lookback)
    log(f"[OK] Posts: +{ingest_stats['inserted']} new, {ingest_stats['updated']} updated")

    if not args.skip_transcripts:
        fetch_transcripts()

    comments_stored = 0
    if not args.skip_comments:
        comments_stored = fetch_comments(lookback)
        log(f"[OK] Comments: {comments_stored} stored")

    summary = get_summary()
    elapsed = int(time.time() - start_time)

    log("=" * 40)
    log(f"Scout complete — {elapsed // 60}m{elapsed % 60}s")
    log(f"  Posts today: {summary.get('posts_today', '?')}")
    log(f"  Ingested: +{ingest_stats['inserted']} new, {ingest_stats['updated']} updated")
    log(f"  Comments: {comments_stored} new")
    if ingest_stats["errors"]:
        log(f"  Errors: {len(ingest_stats['errors'])}")
        for err in ingest_stats["errors"]:
            log(f"    - {err}")
    log("=" * 40)

    print(json.dumps({
        "date": DATE,
        "posts_today": summary.get("posts_today", 0),
        "inserted": ingest_stats["inserted"],
        "updated": ingest_stats["updated"],
        "comments_stored": comments_stored,
        "errors": len(ingest_stats["errors"]),
        "elapsed_seconds": elapsed,
    }))


if __name__ == "__main__":
    main()
