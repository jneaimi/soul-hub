---
name: kt-analyzer
type: agent
model: sonnet
description: Analyze Khaleej Times articles — identify themes, deduplicate, and produce a daily summary
author: jasem
version: 1.0.0

inputs:
  - name: articles
    type: file
    format: json
    description: Scraped articles JSON from kt-scraper

outputs:
  - name: daily-summary
    type: file
    format: markdown
    description: Structured daily summary with themes, top stories, and trend analysis

config: []

env: []

data: {}
---

# kt-analyzer

Reads scraped Khaleej Times articles, groups them by theme, deduplicates near-identical stories, and produces a structured daily markdown summary. Highlights key trends, top stories, and actionable takeaways for UAE local news.
