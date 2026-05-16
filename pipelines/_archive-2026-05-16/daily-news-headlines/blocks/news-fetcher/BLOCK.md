---
name: news-fetcher
type: script
runtime: python
description: Fetch today's news headlines from a configurable source (NewsAPI, Google News RSS, or APIDirect)
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: headlines
    type: file
    format: json
    description: Array of headline objects with title, source, url, publishedAt, and description

config: []

env:
  - name: NEWSAPI_KEY
    description: API key for NewsAPI.org
    required: false
  - name: APIDIRECT_API_KEY
    description: API key for APIDirect News
    required: false

data: {}
---

# news-fetcher

Fetches today's news headlines from whichever source is enabled in `config/sources.json`. Searches for articles matching keywords from `config/categories.json`. Outputs a flat JSON array of headline objects for downstream analysis.

Supports three sources:
- **NewsAPI** — structured JSON API, requires NEWSAPI_KEY
- **Google News RSS** — free RSS feed, no key needed
- **APIDirect** — reuses existing APIDIRECT_API_KEY
