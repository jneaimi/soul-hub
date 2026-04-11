#!/usr/bin/env python3
"""comment-collector — Fetch and filter comments from top trending content."""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
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

APIDIRECT_KEY = os.environ.get("APIDIRECT_API_KEY", "")
YOUTUBE_KEY = os.environ.get("YOUTUBE_API_KEY", "")
APIDIRECT_BASE = "https://apidirect.io/v1"
YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3"

SETTINGS_PATH = PIPELINE_DIR / "config" / "pipeline-settings.json"

# Default spam keywords — overridden by pipeline-settings.json
DEFAULT_SPAM_KEYWORDS = [
    "subscribe", "follow me", "giveaway", "check my profile", "link in bio",
    "dm me", "free followers", "get rich", "make money fast", "check out my",
    "promo code", "discount code", "buy now", "limited offer", "click here",
]


def get_setting(settings, key, default=""):
    for s in settings:
        if s.get("setting") == key:
            return s.get("value", default)
    return default


def api_request(url, headers=None, timeout=30, max_retries=3):
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
    query = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in params.items())
    url = f"{APIDIRECT_BASE}{path}?{query}"
    return api_request(url, headers={"X-API-Key": APIDIRECT_KEY})


def yt_get(path, params):
    params["key"] = YOUTUBE_KEY
    query = "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in params.items())
    url = f"{YOUTUBE_BASE}{path}?{query}"
    return api_request(url)


def extract_items(data):
    if isinstance(data, dict) and "error" in data:
        return []
    for key in ("posts", "tweets", "videos", "comments", "results", "articles", "data", "items"):
        if key in data and isinstance(data[key], list):
            return data[key]
    if isinstance(data, list):
        return data
    return []


def is_spam(text, spam_keywords):
    """Check if comment text matches spam patterns."""
    text_lower = text.lower()
    for kw in spam_keywords:
        if kw.lower() in text_lower:
            return True
    # Heuristic: too many hashtags or mentions
    if text.count("#") > 5 or text.count("@") > 3:
        return True
    # Heuristic: URL-heavy comments
    url_count = len(re.findall(r'https?://\S+', text))
    if url_count > 2:
        return True
    return False


def extract_video_id(url):
    """Extract YouTube video ID from URL."""
    patterns = [
        r'youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})',
        r'youtu\.be/([a-zA-Z0-9_-]{11})',
        r'youtube\.com/embed/([a-zA-Z0-9_-]{11})',
    ]
    for pat in patterns:
        match = re.search(pat, url or "")
        if match:
            return match.group(1)
    return None


def fetch_youtube_comments(video_id, max_pages=2):
    """Fetch comments from a YouTube video via Data API."""
    all_comments = []
    page_token = None
    for _ in range(max_pages):
        params = {
            "part": "snippet", "videoId": video_id,
            "maxResults": 100, "order": "relevance", "textFormat": "plainText"
        }
        if page_token:
            params["pageToken"] = page_token
        data = yt_get("/commentThreads", params)
        if isinstance(data, dict) and "error" in data:
            break
        for item in data.get("items", []):
            s = item.get("snippet", {}).get("topLevelComment", {}).get("snippet", {})
            all_comments.append({
                "text": s.get("textDisplay", ""),
                "author": s.get("authorDisplayName", ""),
                "published_at": s.get("publishedAt", ""),
                "likes": s.get("likeCount", 0),
                "reply_count": item.get("snippet", {}).get("totalReplyCount", 0),
                "platform": "youtube",
            })
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return all_comments


def fetch_reddit_comments(query, pages=2):
    """Fetch Reddit comments via ApiDirect."""
    data = ad_get("/reddit/comments", {"query": query, "pages": pages, "sort": "relevance"})
    comments = []
    for item in extract_items(data):
        comments.append({
            "text": item.get("snippet") or item.get("body") or "",
            "author": item.get("author", ""),
            "published_at": item.get("date", ""),
            "likes": item.get("score", 0) or 0,
            "reply_count": 0,
            "platform": "reddit",
            "subreddit": item.get("subreddit", ""),
        })
    return comments


def fetch_twitter_replies(query, pages=2):
    """Fetch Twitter replies/discussions via search."""
    data = ad_get("/twitter/posts", {"query": query, "pages": pages, "sort_by": "relevance"})
    comments = []
    for item in extract_items(data):
        if item.get("is_reply") or item.get("replies", 0) > 0:
            comments.append({
                "text": item.get("snippet") or item.get("text") or "",
                "author": item.get("author", ""),
                "published_at": item.get("date", ""),
                "likes": item.get("likes", 0) or 0,
                "reply_count": item.get("replies", 0) or 0,
                "platform": "twitter",
            })
    return comments


def main():
    report_status("Loading trends and settings")

    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        write_output({"status": "error", "message": "No input from trend-research", "comments": []})
        return

    with open(INPUT_PATH) as f:
        data = json.load(f)

    trends = data.get("trends", [])
    if not trends:
        write_output({"status": "no_trends", "message": "No trends to collect comments from", "comments": []})
        return

    settings = read_config(SETTINGS_PATH)
    min_comments = int(get_setting(settings, "min_comments_threshold", "5"))
    spam_kw_str = get_setting(settings, "spam_keywords", ",".join(DEFAULT_SPAM_KEYWORDS))
    spam_keywords = [kw.strip() for kw in spam_kw_str.split(",") if kw.strip()]

    # Focus on top engaging trends (top 20 or fewer)
    top_trends = sorted(trends, key=lambda t: t.get("engagement_score", 0), reverse=True)[:20]

    all_comments = []
    warnings = []
    spam_count = 0
    trends_with_comments = []

    for i, trend in enumerate(top_trends):
        pct = int((i / len(top_trends)) * 85)
        platform = trend.get("platform", "")
        title = trend.get("title", "")[:40]
        report_progress(pct, f"Fetching comments from {platform}: {title}...")

        trend_comments = []

        try:
            url = trend.get("url", "")

            if platform == "youtube":
                video_id = extract_video_id(url)
                if video_id:
                    trend_comments = fetch_youtube_comments(video_id)

            elif platform == "reddit":
                query = trend.get("search_query") or trend.get("title", "")
                trend_comments = fetch_reddit_comments(query, pages=1)

            elif platform == "twitter":
                query = trend.get("search_query") or trend.get("title", "")
                trend_comments = fetch_twitter_replies(query, pages=1)

            # For other platforms, use the search query to find discussions
            elif platform in ("tiktok", "instagram", "facebook", "linkedin"):
                query = trend.get("search_query") or trend.get("title", "")
                # Try Reddit and Twitter as proxy for discussion
                trend_comments.extend(fetch_reddit_comments(query, pages=1))

        except Exception as e:
            warnings.append(f"Error fetching comments for {platform} trend: {str(e)}")
            continue

        # Filter spam
        clean_comments = []
        for comment in trend_comments:
            text = comment.get("text", "")
            if not text or len(text.strip()) < 10:
                continue
            if is_spam(text, spam_keywords):
                spam_count += 1
                comment["is_spam"] = True
            else:
                comment["is_spam"] = False
                comment["trend_title"] = trend.get("title", "")
                comment["trend_url"] = trend.get("url", "")
                comment["trend_platform"] = trend.get("platform", "")
                comment["search_query"] = trend.get("search_query", "")
                clean_comments.append(comment)

        if clean_comments:
            all_comments.extend(clean_comments)
            trends_with_comments.append({
                "title": trend.get("title", ""),
                "platform": trend.get("platform", ""),
                "comment_count": len(clean_comments),
            })

    # Filter out trends with too few comments
    if min_comments > 0:
        below_threshold = [t for t in trends_with_comments if t["comment_count"] < min_comments]
        if below_threshold:
            warnings.append(f"{len(below_threshold)} trends had fewer than {min_comments} comments")

    result = {
        "status": "ok",
        "total_trends_checked": len(top_trends),
        "trends_with_comments": len(trends_with_comments),
        "total_comments": len(all_comments),
        "spam_filtered": spam_count,
        "comments": all_comments,
        "comment_sources": trends_with_comments,
        "warnings": warnings,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    write_output(result)
    report_progress(100, f"Done — {len(all_comments)} clean comments from {len(trends_with_comments)} trends (filtered {spam_count} spam)")


if __name__ == "__main__":
    with_error_handling(main)()
