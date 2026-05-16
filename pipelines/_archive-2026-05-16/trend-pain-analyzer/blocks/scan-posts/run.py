#!/usr/bin/env python3
"""scan-posts — Fetch recent posts from tracked influencers across all platforms."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from json_config import read_config
from output_writer import write_output
from progress import report_progress, report_status

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent)))
INPUT_PATH = os.environ.get("PIPELINE_INPUT", "")
OUTPUT_PATH = os.environ.get("PIPELINE_OUTPUT", "")
MODE = os.environ.get("BLOCK_CONFIG_MODE", "daily")

APIDIRECT_KEY = os.environ.get("APIDIRECT_API_KEY", "")
YOUTUBE_KEY = os.environ.get("YOUTUBE_API_KEY", "")
APIDIRECT_BASE = "https://apidirect.io/v1"
YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3"

# Read settings
SETTINGS_PATH = PIPELINE_DIR / "config" / "pipeline-settings.json"
ROSTER_PATH = PIPELINE_DIR / "config" / "influencer-roster.json"


def get_setting(settings, key, default=""):
    for s in settings:
        if s.get("setting") == key:
            return s.get("value", default)
    return default


def api_request(url, headers=None, timeout=30, max_retries=3):
    """HTTP GET with retries and exponential backoff."""
    hdrs = {"User-Agent": "SoulHub-Pipeline/1.0"}
    if headers:
        hdrs.update(headers)
    last_error = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_error = f"HTTP {e.code}: {e.reason}"
            if e.code in (429, 500, 502, 503, 504) and attempt < max_retries - 1:
                time.sleep(2 ** attempt)
            else:
                break
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = str(e)
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
    return {"error": last_error}


def ad_get(path, params):
    """ApiDirect GET request."""
    query = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in params.items())
    url = f"{APIDIRECT_BASE}{path}?{query}"
    return api_request(url, headers={"X-API-Key": APIDIRECT_KEY})


def yt_get(path, params):
    """YouTube Data API GET request."""
    params["key"] = YOUTUBE_KEY
    query = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in params.items())
    url = f"{YOUTUBE_BASE}{path}?{query}"
    return api_request(url)


def extract_items(data):
    """Extract items list from various API response formats."""
    if isinstance(data, dict) and "error" in data:
        return []
    for key in ("posts", "tweets", "videos", "results", "articles", "data", "items"):
        if key in data and isinstance(data[key], list):
            return data[key]
    if isinstance(data, list):
        return data
    return []


def normalize_engagement(item, platform):
    """Normalize engagement fields across platforms to a common schema."""
    likes = item.get("likes", 0) or item.get("likeCount", 0) or item.get("reactions", 0) or 0
    comments = item.get("comments", 0) or item.get("commentCount", 0) or item.get("replies", 0) or 0
    shares = item.get("shares", 0) or item.get("retweets", 0) or item.get("reshare_count", 0) or 0
    views = item.get("views", 0) or item.get("viewCount", 0) or item.get("play_count", 0) or 0

    title = (item.get("title") or item.get("snippet") or item.get("text")
             or item.get("caption") or item.get("body") or item.get("description") or "")
    if isinstance(title, str) and len(title) > 500:
        title = title[:500]

    return {
        "title": title,
        "snippet": (item.get("snippet") or item.get("text") or item.get("description") or "")[:300],
        "url": item.get("url") or item.get("link") or "",
        "published_at": item.get("date") or item.get("publishedAt") or item.get("timestamp") or "",
        "likes": int(likes),
        "comments": int(comments),
        "shares": int(shares),
        "views": int(views),
        "total_engagement": int(likes) + int(comments) + int(shares),
        "platform": platform,
        "author": item.get("author") or item.get("channelTitle") or item.get("author_name") or "",
        "raw_data": json.dumps(item, default=str, ensure_ascii=False)[:2000],
    }


def fetch_twitter(handle, pages):
    data = ad_get("/twitter/user/tweets", {"username": handle, "pages": pages})
    return extract_items(data)


def fetch_youtube(handle, max_results=20):
    # First get channel ID
    ch_data = yt_get("/channels", {"part": "contentDetails,snippet", "forHandle": handle.lstrip("@")})
    channels = ch_data.get("items", [])
    if not channels:
        return []
    channel_id = channels[0]["id"]
    # Search recent videos from channel
    data = yt_get("/search", {
        "part": "snippet", "channelId": channel_id,
        "order": "date", "maxResults": max_results, "type": "video"
    })
    video_ids = [item["id"]["videoId"] for item in data.get("items", []) if item.get("id", {}).get("videoId")]
    if not video_ids:
        return []
    # Get statistics for each video
    stats_data = yt_get("/videos", {"part": "snippet,statistics", "id": ",".join(video_ids)})
    results = []
    for v in stats_data.get("items", []):
        s = v.get("snippet", {})
        st = v.get("statistics", {})
        results.append({
            "title": s.get("title", ""),
            "snippet": s.get("description", "")[:300],
            "url": f"https://youtube.com/watch?v={v['id']}",
            "date": s.get("publishedAt", ""),
            "views": int(st.get("viewCount", 0)),
            "likes": int(st.get("likeCount", 0)),
            "comments": int(st.get("commentCount", 0)),
            "shares": 0,
            "video_id": v["id"],
            "author": s.get("channelTitle", ""),
        })
    return results


def fetch_tiktok(handle, pages):
    data = ad_get("/tiktok/videos", {"query": f"@{handle}", "pages": pages, "sort_by": "most_recent"})
    return extract_items(data)


def fetch_instagram(handle, pages):
    data = ad_get("/instagram/posts", {"query": f"@{handle}", "pages": pages})
    return extract_items(data)


def fetch_linkedin(handle, pages):
    data = ad_get("/linkedin/posts", {"query": handle, "page": 1, "sort": "most_recent"})
    return extract_items(data)


def fetch_reddit(handle, pages):
    data = ad_get("/reddit/posts", {"query": f"author:{handle}", "page": 1, "sort": "new"})
    return extract_items(data)


def fetch_facebook(handle, pages):
    data = ad_get("/facebook/posts", {"query": handle, "pages": pages, "sort_by": "most_recent"})
    return extract_items(data)


PLATFORM_FETCHERS = {
    "twitter": fetch_twitter,
    "youtube": fetch_youtube,
    "tiktok": fetch_tiktok,
    "instagram": fetch_instagram,
    "linkedin": fetch_linkedin,
    "reddit": fetch_reddit,
    "facebook": fetch_facebook,
}


def main():
    if MODE == "weekly":
        report_status("Skipping scan-posts in weekly mode")
        write_output({"status": "skipped", "mode": "weekly", "posts": []})
        return

    report_status("Loading influencer roster and settings")
    roster = read_config(ROSTER_PATH)
    settings = read_config(SETTINGS_PATH)

    active_influencers = [r for r in roster if r.get("active") == "true"]
    if not active_influencers:
        write_output({"status": "no_active_influencers", "posts": [], "warnings": ["No active influencers in roster"]})
        return

    lookback_days = int(get_setting(settings, "lookback_days", "7"))
    max_pages = int(get_setting(settings, "max_pages_per_platform", "3"))
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    all_posts = []
    warnings = []
    api_cost = 0.0

    for i, inf in enumerate(active_influencers):
        name = inf["name"]
        platform = inf["platform"]
        handle = inf["handle"]

        pct = int((i / len(active_influencers)) * 80)
        report_progress(pct, f"Scanning {name} on {platform}")

        fetcher = PLATFORM_FETCHERS.get(platform)
        if not fetcher:
            warnings.append(f"Unknown platform '{platform}' for {name}")
            continue

        try:
            if platform == "youtube":
                raw_items = fetcher(handle, max_results=max_pages * 10)
            else:
                raw_items = fetcher(handle, max_pages)
        except Exception as e:
            warnings.append(f"Error fetching {name} on {platform}: {str(e)}")
            continue

        if not raw_items:
            warnings.append(f"No posts found for {name} on {platform} in the last {lookback_days} days")
            continue

        for item in raw_items:
            normalized = normalize_engagement(item, platform)
            normalized["influencer_name"] = name
            normalized["handle"] = handle
            all_posts.append(normalized)

    report_progress(90, "Sorting by engagement")
    all_posts.sort(key=lambda p: p["total_engagement"], reverse=True)

    result = {
        "status": "ok",
        "mode": "daily",
        "total_posts": len(all_posts),
        "influencers_scanned": len(active_influencers),
        "lookback_days": lookback_days,
        "posts": all_posts,
        "warnings": warnings,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    write_output(result)
    report_progress(100, f"Done — {len(all_posts)} posts from {len(active_influencers)} influencers")


if __name__ == "__main__":
    with_error_handling(main)()
