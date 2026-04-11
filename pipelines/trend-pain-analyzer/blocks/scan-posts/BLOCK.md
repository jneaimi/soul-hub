---
name: scan-posts
type: script
runtime: python
description: Fetch recent posts from tracked influencers across all platforms using ApiDirect + YouTube Data API
author: jasem
version: 1.0.0

inputs:
  - name: influencer_roster
    type: file
    format: json
    description: List of influencers with name, platform, handle, active status

outputs:
  - name: posts
    type: file
    format: json
    description: All fetched posts with engagement metrics per influencer
  - name: db_rows
    type: action
    action: db-write
    description: Posts stored in SQLite for persistence

config:
  - name: mode
    type: select
    label: Run Mode
    description: Pipeline mode — only runs in daily mode
    options: [daily, weekly]
    default: daily
    required: true

env:
  - name: APIDIRECT_API_KEY
    description: ApiDirect API key for social platform access
    required: true
  - name: YOUTUBE_API_KEY
    description: YouTube Data API key for channel/video data
    required: true

data:
  requires: [influencer-roster]
  produces: [posts]
  database: trends.db
---

# Scan Posts

Fetches recent posts from all active influencers in the roster. Supports Twitter/X, YouTube, TikTok, Instagram, LinkedIn, Reddit, and Facebook via ApiDirect + YouTube Data API. Outputs posts with normalized engagement metrics (likes, comments, shares, views, total_engagement).
