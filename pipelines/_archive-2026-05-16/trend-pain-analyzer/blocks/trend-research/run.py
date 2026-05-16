#!/usr/bin/env python3
"""trend-research — Search trends across platforms using top titles as queries."""
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
TARGET_REGION = os.environ.get("BLOCK_CONFIG_TARGET_REGION", "")
LOOKBACK = os.environ.get("BLOCK_CONFIG_LOOKBACK", "24h")

SETTINGS_PATH = PIPELINE_DIR / "config" / "pipeline-settings.json"

LOOKBACK_MAP = {"24h": timedelta(hours=24), "48h": timedelta(hours=48), "7d": timedelta(days=7)}

APIDIRECT_KEY = os.environ.get("APIDIRECT_API_KEY", "")
YOUTUBE_KEY = os.environ.get("YOUTUBE_API_KEY", "")
APIDIRECT_BASE = "https://apidirect.io/v1"
YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3"

# Region to country code mapping for YouTube
REGION_CODES = {
    "uae": "AE", "dubai": "AE", "abu dhabi": "AE", "saudi": "SA", "saudi arabia": "SA",
    "riyadh": "SA", "jeddah": "SA", "qatar": "QA", "doha": "QA", "kuwait": "KW",
    "bahrain": "BH", "oman": "OM", "egypt": "EG", "jordan": "JO", "iraq": "IQ",
    "usa": "US", "uk": "GB", "india": "IN", "germany": "DE", "france": "FR",
    "japan": "JP", "korea": "KR", "brazil": "BR", "canada": "CA", "australia": "AU",
}

# Common Arabic equivalents for trend terms
ARABIC_TERMS = {
    "ai": "ذكاء اصطناعي", "automation": "أتمتة", "startup": "شركة ناشئة",
    "ecommerce": "تجارة إلكترونية", "marketing": "تسويق", "health": "صحة",
    "fitness": "لياقة", "investment": "استثمار", "crypto": "عملات رقمية",
    "remote work": "عمل عن بعد", "freelance": "عمل حر", "education": "تعليم",
    "technology": "تكنولوجيا", "business": "أعمال", "finance": "مالية",
}


def get_setting(settings, key, default=""):
    for s in settings:
        if s.get("setting") == key:
            return s.get("value", default)
    return default


def get_lookback_cutoff(lookback_str):
    delta = LOOKBACK_MAP.get(lookback_str, timedelta(hours=24))
    return (datetime.now(timezone.utc) - delta).isoformat()


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
    for key in ("posts", "tweets", "videos", "results", "articles", "data", "items"):
        if key in data and isinstance(data[key], list):
            return data[key]
    if isinstance(data, list):
        return data
    return []


def get_region_code(region):
    return REGION_CODES.get(region.lower().strip(), "US")


def generate_arabic_query(query):
    """Generate Arabic version of a search query."""
    q_lower = query.lower()
    for en, ar in ARABIC_TERMS.items():
        if en in q_lower:
            return q_lower.replace(en, ar)
    return None


def search_platform(platform, query, pages=2, region=""):
    """Search a single platform and return normalized results."""
    results = []

    if platform == "twitter":
        data = ad_get("/twitter/posts", {"query": query, "pages": pages, "sort_by": "relevance"})
        for item in extract_items(data):
            results.append(normalize_trend(item, "twitter", query))

    elif platform == "youtube":
        data = ad_get("/youtube/posts", {"query": query, "pages": pages})
        for item in extract_items(data):
            results.append(normalize_trend(item, "youtube", query))

    elif platform == "tiktok":
        params = {"query": query, "pages": pages, "sort_by": "relevance"}
        if region:
            params["region"] = get_region_code(region)
        data = ad_get("/tiktok/videos", params)
        for item in extract_items(data):
            results.append(normalize_trend(item, "tiktok", query))

    elif platform == "instagram":
        data = ad_get("/instagram/posts", {"query": query, "pages": pages})
        for item in extract_items(data):
            results.append(normalize_trend(item, "instagram", query))

    elif platform == "linkedin":
        data = ad_get("/linkedin/posts", {"query": query, "page": 1, "sort": "relevance"})
        for item in extract_items(data):
            results.append(normalize_trend(item, "linkedin", query))

    elif platform == "reddit":
        data = ad_get("/reddit/posts", {"query": query, "page": 1, "sort": "relevance"})
        for item in extract_items(data):
            results.append(normalize_trend(item, "reddit", query))

    elif platform == "facebook":
        data = ad_get("/facebook/posts", {"query": query, "pages": pages, "sort_by": "relevance"})
        for item in extract_items(data):
            results.append(normalize_trend(item, "facebook", query))

    elif platform == "news":
        params = {"query": query, "limit": 20}
        if region:
            params["country"] = get_region_code(region)
        data = ad_get("/news/articles", params)
        for item in extract_items(data):
            results.append(normalize_trend(item, "news", query))

    elif platform == "forums":
        data = ad_get("/forums/posts", {"query": query, "page": 1})
        for item in extract_items(data):
            results.append(normalize_trend(item, "forums", query))

    return results


def normalize_trend(item, platform, query):
    likes = item.get("likes", 0) or item.get("likeCount", 0) or item.get("reactions", 0) or 0
    comments = item.get("comments", 0) or item.get("commentCount", 0) or item.get("replies", 0) or 0
    shares = item.get("shares", 0) or item.get("retweets", 0) or 0
    views = item.get("views", 0) or item.get("viewCount", 0) or item.get("play_count", 0) or 0

    return {
        "search_query": query,
        "platform": platform,
        "title": (item.get("title") or item.get("snippet") or item.get("text") or "")[:500],
        "snippet": (item.get("snippet") or item.get("text") or item.get("description") or "")[:300],
        "url": item.get("url") or item.get("link") or "",
        "author": item.get("author") or item.get("channelTitle") or item.get("source") or "",
        "published_at": item.get("date") or item.get("publishedAt") or "",
        "likes": int(likes),
        "comments": int(comments),
        "shares": int(shares),
        "views": int(views),
        "engagement_score": int(likes) + int(comments) + int(shares),
        "raw_data": json.dumps(item, default=str, ensure_ascii=False)[:2000],
    }


PLATFORMS = ["twitter", "youtube", "tiktok", "instagram", "reddit", "facebook", "news", "forums"]


def main():
    report_status("Loading settings and top titles")

    # Load pipeline settings
    settings = read_config(SETTINGS_PATH)
    platforms_str = get_setting(settings, "search_platforms", ",".join(PLATFORMS))
    active_platforms = [p.strip() for p in platforms_str.split(",") if p.strip() in PLATFORMS]
    if not active_platforms:
        active_platforms = list(PLATFORMS)
    max_per_platform = int(get_setting(settings, "max_per_platform", "50"))
    max_total = int(get_setting(settings, "max_total_trends", "200"))
    cutoff = get_lookback_cutoff(LOOKBACK)

    if not INPUT_PATH or not Path(INPUT_PATH).exists():
        write_output({"status": "error", "message": "No input from title-ranker", "trends": []})
        return

    with open(INPUT_PATH) as f:
        data = json.load(f)

    top_titles = data.get("top_titles", [])
    if not top_titles:
        write_output({"status": "no_titles", "message": "No top titles to research", "trends": []})
        return

    region = TARGET_REGION
    all_trends = []
    warnings = []

    total_searches = len(top_titles) * len(active_platforms)
    search_count = 0

    for title_entry in top_titles:
        title = title_entry.get("title", "")
        if not title:
            continue

        # Generate search queries: original + region-qualified + Arabic variant
        queries = [title]
        if region:
            queries.append(f"{title} {region}")
        ar_query = generate_arabic_query(title)
        if ar_query:
            queries.append(ar_query)

        for platform in active_platforms:
            search_count += 1
            pct = int((search_count / total_searches) * 90)
            report_progress(pct, f"Searching {platform} for: {title[:40]}...")

            platform_results = []
            for query in queries:
                try:
                    results = search_platform(platform, query, pages=1, region=region)
                    for r in results:
                        r["target_region"] = region
                        r["source_title_rank"] = title_entry.get("rank", 0)
                    platform_results.extend(results)
                except Exception as e:
                    warnings.append(f"Error searching {platform} for '{query[:50]}': {str(e)}")

            # Cap per-platform results
            platform_results.sort(key=lambda t: t["engagement_score"], reverse=True)
            all_trends.extend(platform_results[:max_per_platform])

    # Sort by engagement and deduplicate by URL
    all_trends.sort(key=lambda t: t["engagement_score"], reverse=True)
    seen_urls = set()
    deduped = []
    for trend in all_trends:
        url = trend.get("url", "")
        if url and url in seen_urls:
            continue
        if url:
            seen_urls.add(url)
        deduped.append(trend)

    # Filter by lookback cutoff (lenient: keep items with no published_at)
    deduped = [t for t in deduped if not t.get("published_at") or t["published_at"] >= cutoff]

    # Cap total trends
    deduped = deduped[:max_total]

    result = {
        "status": "ok",
        "target_region": region,
        "lookback": LOOKBACK,
        "active_platforms": active_platforms,
        "max_per_platform": max_per_platform,
        "max_total_trends": max_total,
        "titles_researched": len(top_titles),
        "platforms_searched": len(active_platforms),
        "total_trends_found": len(deduped),
        "trends": deduped,
        "warnings": warnings,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    write_output(result)
    report_progress(100, f"Done — {len(deduped)} trends across {len(active_platforms)} platforms")


if __name__ == "__main__":
    with_error_handling(main)()
