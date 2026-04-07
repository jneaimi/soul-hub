---
name: post-fetcher
type: script
runtime: python
description: Fetch last 24h posts from tracked influencers across social platforms
author: jasem
version: 1.0.0

inputs:
  - name: roster_file
    type: file
    format: json
    description: Influencer roster with handle, platform, focus columns
    default: config/influencer-roster.json

outputs:
  - name: status
    type: json
    description: Summary of posts collected
  - name: posts
    type: db-table
    table: posts
    description: Ingested posts in SQLite

config:
  - name: lookback_days
    type: number
    default: 1
    min: 1
    max: 7
    label: Lookback days
    description: How many days back to fetch (default 1 for last 24h)
  - name: platforms
    type: multiselect
    options: [tiktok, youtube, twitter, linkedin, reddit, instagram]
    default: [tiktok, youtube, twitter, linkedin, reddit, instagram]
    label: Platforms
    description: Which social platforms to fetch from
  - name: skip_comments
    type: toggle
    default: true
    label: Skip comments
    description: Skip fetching comments (not needed for engagement ranking)
  - name: skip_transcripts
    type: toggle
    default: true
    label: Skip transcripts
    description: Skip fetching transcripts (not needed for engagement ranking)

env:
  - name: APIDIRECT_API_KEY
    description: Social media API key
    required: true
  - name: YOUTUBE_API_KEY
    description: YouTube Data API key
    required: true

data:
  requires: [influencers]
  produces: [posts]
  database: data.db
---

# Post Fetcher

Forked from `influencer-scanner`. Fetches last 24h posts from tracked influencers.
Stores posts with engagement metrics (likes, comments, shares, views) in SQLite.
