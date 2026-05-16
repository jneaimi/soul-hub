---
name: weekly-extractor
type: script
runtime: python
description: Extract and aggregate the last 7 days of data from the database for weekly strategic analysis
author: jasem
version: 1.0.0

inputs: []

outputs:
  - name: weekly_data
    type: file
    format: json
    description: Aggregated weekly data — posts, titles, trends, comments, pain points from the past 7 days

config:
  - name: mode
    type: select
    label: Run Mode
    description: Pipeline mode — only runs in weekly mode
    options: [daily, weekly]
    default: weekly
    required: true

env: []

data:
  requires: []
  produces: [weekly_data]
  database: trends.db
---

# Weekly Extractor

Queries the SQLite database for all data accumulated over the past 7 days (posts, top titles, trends, comments). Aggregates stats and outputs a structured JSON summary for the weekly-strategist agent to analyze.
