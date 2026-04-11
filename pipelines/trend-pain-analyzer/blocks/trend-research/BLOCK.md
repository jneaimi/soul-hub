---
name: trend-research
type: script
runtime: python
description: Research social trends across configurable platforms using top titles as search queries, with platform/limit/lookback filtering via pipeline settings
author: jasem
version: 1.0.0

inputs:
  - name: top_titles
    type: file
    format: json
    description: Top ranked titles from title-ranker step

outputs:
  - name: trends
    type: file
    format: json
    description: Trend research results across platforms with engagement data

config:
  - name: target_region
    type: text
    label: Target Region
    description: Country, city, or region to focus trend research on
    required: true
  - name: lookback
    type: select
    label: Lookback Window
    description: How far back to search (24h, 48h, 7d)
    options: ["24h", "48h", "7d"]
    default: "24h"
    required: false

env:
  - name: APIDIRECT_API_KEY
    description: ApiDirect API key for multi-platform search
    required: true
  - name: YOUTUBE_API_KEY
    description: YouTube Data API key for trending and search
    required: true

data:
  requires: [top_titles]
  produces: [trends]
---

# Trend Research

Takes the top N titles from the title-ranker and uses them as search queries across platforms configured in `pipeline-settings.json` (default: twitter, youtube, tiktok, reddit). Respects per-platform result caps and total trend limits. Filters by lookback window (24h/48h/7d). Searches are region-targeted and bilingual (adds Arabic query variants). Outputs trend results ranked by engagement.
