---
name: comment-collector
type: script
runtime: python
description: Fetch comments on the most engaging trends and filter out spam/ads
author: jasem
version: 1.0.0

inputs:
  - name: trends
    type: file
    format: json
    description: Trend research results from trend-research step

outputs:
  - name: comments
    type: file
    format: json
    description: Filtered comments from top trending content

config: []

env:
  - name: APIDIRECT_API_KEY
    description: ApiDirect API key for Reddit comments
    required: true
  - name: YOUTUBE_API_KEY
    description: YouTube Data API key for video comments
    required: true

data:
  requires: [trends]
  produces: [comments]
---

# Comment Collector

Reads trend research results, identifies the most engaging content, fetches comments from supported platforms (YouTube comments via Data API, Reddit comments via ApiDirect, Twitter replies via ApiDirect). Filters out spam and ads using keyword blocklist + heuristics. Outputs clean comments for pain point analysis.
