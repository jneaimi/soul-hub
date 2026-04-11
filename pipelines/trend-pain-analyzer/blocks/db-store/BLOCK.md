---
name: db-store
type: script
runtime: python
description: Persist all pipeline data (posts, titles, trends, comments) into SQLite for querying and weekly analysis
author: jasem
version: 1.0.0

inputs:
  - name: pipeline_data
    type: file
    format: json
    description: Multi-input — receives scan-posts, rank-titles, trend-research, and collect-comments outputs

outputs:
  - name: store_summary
    type: file
    format: json
    description: Summary of rows inserted per table
  - name: db_rows
    type: action
    action: db-write
    description: Data persisted to trends.db

config:
  - name: mode
    type: select
    label: Run Mode
    description: Pipeline mode
    options: [daily, weekly]
    default: daily
    required: true

env: []

data:
  requires: [posts, top_titles, trends, comments]
  produces: [store_summary]
  database: trends.db
---

# DB Store

Receives outputs from all prior daily steps (scan-posts, title-ranker, trend-research, comment-collector) and persists them into the SQLite database (trends.db). Creates a run record and inserts all data with foreign key references. Enables the weekly-extractor to query accumulated data.
