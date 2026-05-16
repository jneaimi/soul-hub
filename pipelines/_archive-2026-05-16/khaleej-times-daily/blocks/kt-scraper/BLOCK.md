---
name: kt-scraper
type: script
runtime: python
description: Scrape Khaleej Times UAE section for today's news articles
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: articles
    type: file
    format: json
    description: Array of scraped articles with title, url, snippet, source, and published date

config: []

env: []

data: {}
---

# kt-scraper

Scrapes the Khaleej Times website for UAE local news. Reads configurable sections from `config/sections.json`, fetches the HTML, extracts article headlines/links/snippets, and outputs structured JSON. Falls back to KT's RSS feed if HTML scraping fails.
