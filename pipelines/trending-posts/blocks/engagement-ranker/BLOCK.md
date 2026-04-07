---
name: engagement-ranker
type: script
runtime: python
description: Rank posts by total engagement and output top N as markdown table
author: jasem
version: 1.0.0

inputs:
  - name: posts
    type: db-table
    table: posts
    description: Posts table populated by post-fetcher

outputs:
  - name: report
    type: file
    format: markdown
    description: Top N posts ranked by engagement

config:
  - name: top_n
    type: number
    default: 10
    min: 1
    max: 50
    label: Top N
    description: Number of top posts to include in the report

data:
  requires: [posts, influencers]
  database: data.db
---

# Engagement Ranker

Queries posts from the last 24h, ranks by total engagement (likes + comments + shares), and writes a markdown report with the top N results.
