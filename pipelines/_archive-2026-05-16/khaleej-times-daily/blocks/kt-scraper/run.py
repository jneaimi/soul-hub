#!/usr/bin/env python3
"""kt-scraper — Fetch Khaleej Times UAE news via Google News RSS."""
import os, json, sys, re, xml.etree.ElementTree as ET
import urllib.request
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import quote_plus

# Add components to import path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent / "_builder" / "components"))
from error_handler import with_error_handling
from json_config import read_config
from output_writer import write_output

PIPELINE_DIR = Path(os.environ.get("PIPELINE_DIR", str(Path(__file__).resolve().parent.parent.parent)))
USER_AGENT = "SoulHub-Pipeline/1.0"

# Google News RSS filtered to khaleejtimes.com, UAE region
GNEWS_BASE = "https://news.google.com/rss/search"


def fetch_xml(url, timeout=20):
    """Fetch and parse XML from a URL."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read().decode("utf-8", errors="replace")
    return ET.fromstring(data)


def clean_title(title):
    """Remove ' - Khaleej Times' suffix from Google News titles."""
    return re.sub(r'\s*[-–—]\s*Khaleej Times\s*$', '', title).strip()


def fetch_google_news_rss(section_name, section_keywords):
    """Fetch KT articles from Google News RSS for a given section.

    Uses site:khaleejtimes.com to filter results to KT only.
    """
    # Build query: site filter + section keywords
    kw_part = f" {section_keywords}" if section_keywords else ""
    query = f"site:khaleejtimes.com{kw_part}"
    url = f"{GNEWS_BASE}?q={quote_plus(query)}&hl=en&gl=AE&ceid=AE:en"

    print(f"  Google News RSS: q={query}")
    root = fetch_xml(url, timeout=20)

    articles = []
    seen_titles = set()

    for item in root.findall(".//item"):
        raw_title = item.findtext("title", "").strip()
        title = clean_title(raw_title)
        link = item.findtext("link", "").strip()
        pub_date = item.findtext("pubDate", "").strip()
        source = item.findtext("source", "Khaleej Times").strip()
        description = item.findtext("description", "").strip()
        # Clean HTML from description
        snippet = re.sub(r'<[^>]+>', '', description).strip()[:200]

        if not title or title in seen_titles:
            continue
        # Skip if not actually from KT (Google may include others)
        if "khaleej" not in source.lower() and "khaleej" not in raw_title.lower():
            continue

        seen_titles.add(title)
        articles.append({
            "title": title,
            "url": link,
            "source": "Khaleej Times",
            "snippet": snippet,
            "published_at": pub_date,
            "section": section_name,
        })

    return articles


def main():
    # 1. Read config
    sections = read_config(PIPELINE_DIR / "config" / "sections.json")
    if not sections:
        raise ValueError("No sections configured in config/sections.json")

    all_articles = []
    seen_titles = set()

    # 2. Fetch each enabled section
    for section in sections:
        if section.get("enabled") != "true":
            continue

        section_name = section.get("name", "UAE")
        section_keywords = section.get("keywords", "UAE")
        print(f"Fetching: {section_name}")

        try:
            articles = fetch_google_news_rss(section_name, section_keywords)
            print(f"  Found {len(articles)} articles")

            # Deduplicate across sections
            for a in articles:
                if a["title"] not in seen_titles:
                    seen_titles.add(a["title"])
                    all_articles.append(a)
        except Exception as e:
            print(f"  Failed: {e}")

    print(f"\nTotal unique articles: {len(all_articles)}")

    if len(all_articles) < 5:
        print("WARNING: Fewer than 5 articles found — check network or query")

    # 3. Write output
    result = {
        "source": "Khaleej Times",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "total_articles": len(all_articles),
        "articles": all_articles,
    }
    write_output(result, fmt="json")


if __name__ == "__main__":
    with_error_handling(main)()
