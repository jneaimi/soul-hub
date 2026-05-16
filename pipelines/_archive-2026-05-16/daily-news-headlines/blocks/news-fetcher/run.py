#!/usr/bin/env python3
"""news-fetcher — Fetch today's news headlines from a configurable source."""
import os, json, sys, xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import quote_plus

# Add components to import path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from json_config import read_config
from api_client import fetch_json, _request
from output_writer import write_output

# Pipeline context
PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))


def get_active_source(sources):
    """Return the first enabled source from config."""
    for src in sources:
        if src.get("enabled") == "true":
            return src
    return None


def get_fallback_sources(sources, active_type):
    """Return other sources to try if the active one fails. Prefer google_rss (no key needed)."""
    others = [s for s in sources if s["type"] != active_type]
    others.sort(key=lambda s: 0 if s["type"] == "google_rss" else 1)
    return others


def get_all_keywords(categories):
    """Collect all keywords from categories into a flat list."""
    all_kw = []
    for cat in categories:
        kw = cat.get("keywords", "")
        all_kw.extend([k.strip() for k in kw.split(",") if k.strip()])
    return all_kw


def fetch_newsapi(base_url, api_key, keywords):
    """Fetch headlines from NewsAPI.org."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    query = " OR ".join(keywords[:5])  # NewsAPI limits query length
    url = f"{base_url}/everything?q={quote_plus(query)}&from={today}&sortBy=publishedAt&pageSize=100&apiKey={api_key}"
    data = fetch_json(url, timeout=30)
    articles = data.get("articles", [])
    return [
        {
            "title": a.get("title", ""),
            "source": a.get("source", {}).get("name", "Unknown"),
            "url": a.get("url", ""),
            "published_at": a.get("publishedAt", ""),
            "description": a.get("description", ""),
        }
        for a in articles
        if a.get("title") and a.get("title") != "[Removed]"
    ]


def fetch_google_rss(base_url, keywords):
    """Fetch headlines from Google News RSS feed."""
    import urllib.request
    articles = []
    # Fetch top headlines + keyword-specific feeds
    feeds = [f"{base_url}/search?q={quote_plus(kw)}&hl=en&gl=US&ceid=US:en" for kw in keywords[:8]]
    feeds.insert(0, f"{base_url}?hl=en&gl=US&ceid=US:en")  # Top headlines

    seen_titles = set()
    for feed_url in feeds:
        try:
            req = urllib.request.Request(feed_url, headers={"User-Agent": "SoulHub-Pipeline/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                xml_data = resp.read().decode("utf-8")
            root = ET.fromstring(xml_data)
            for item in root.findall(".//item"):
                title = item.findtext("title", "")
                if title and title not in seen_titles:
                    seen_titles.add(title)
                    articles.append({
                        "title": title,
                        "source": item.findtext("source", "Unknown"),
                        "url": item.findtext("link", ""),
                        "published_at": item.findtext("pubDate", ""),
                        "description": item.findtext("description", ""),
                    })
        except Exception:
            continue  # Skip failed feeds, try the rest

    return articles


def fetch_apidirect(base_url, api_key, keywords):
    """Fetch headlines from APIDirect News API."""
    query = " ".join(keywords[:5])
    url = f"{base_url}/v1/news/search?query={quote_plus(query)}&limit=100"
    headers = {"Authorization": f"Bearer {api_key}"}
    data = fetch_json(url, headers=headers, timeout=30)
    articles = data.get("results", data.get("articles", []))
    return [
        {
            "title": a.get("title", ""),
            "source": a.get("source", {}).get("name", a.get("source", "Unknown")),
            "url": a.get("url", a.get("link", "")),
            "published_at": a.get("publishedAt", a.get("published_at", "")),
            "description": a.get("description", a.get("snippet", "")),
        }
        for a in articles
        if a.get("title")
    ]


def main():
    # 1. Read configs
    sources = read_config(PIPELINE_DIR / "config" / "sources.json")
    categories = read_config(PIPELINE_DIR / "config" / "categories.json")

    if not sources:
        raise ValueError("No sources configured in config/sources.json")
    if not categories:
        raise ValueError("No categories configured in config/categories.json")

    source = get_active_source(sources)
    if not source:
        raise ValueError("No source is enabled — set enabled to 'true' for one source in config/sources.json")

    keywords = get_all_keywords(categories)

    print(f"Keywords: {', '.join(keywords[:10])}{'...' if len(keywords) > 10 else ''}")

    # 2. Try active source, fall back to others on failure
    sources_to_try = [source] + get_fallback_sources(sources, source["type"])
    articles = None
    used_source = None

    for src in sources_to_try:
        st = src["type"]
        bu = src["base_url"]
        print(f"Trying: {src['name']} ({st})")
        try:
            if st == "newsapi":
                api_key = os.environ.get(src.get("env_key", "NEWSAPI_KEY"), "")
                if not api_key:
                    print(f"  Skipped — missing env var {src.get('env_key', 'NEWSAPI_KEY')}")
                    continue
                articles = fetch_newsapi(bu, api_key, keywords)
            elif st == "google_rss":
                articles = fetch_google_rss(bu, keywords)
            elif st == "apidirect":
                api_key = os.environ.get(src.get("env_key", "APIDIRECT_API_KEY"), "")
                if not api_key:
                    print(f"  Skipped — missing env var {src.get('env_key', 'APIDIRECT_API_KEY')}")
                    continue
                articles = fetch_apidirect(bu, api_key, keywords)
            else:
                print(f"  Skipped — unknown type: {st}")
                continue

            used_source = src
            break
        except Exception as e:
            print(f"  Failed: {e}")
            continue

    if articles is None:
        raise ValueError("All news sources failed — check API keys and network connectivity")

    print(f"Fetched {len(articles)} articles from {used_source['name']}")

    # 3. Write output
    result = {
        "source": used_source["name"],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "total_articles": len(articles),
        "articles": articles,
    }
    write_output(result, fmt="json")


if __name__ == "__main__":
    with_error_handling(main)()
