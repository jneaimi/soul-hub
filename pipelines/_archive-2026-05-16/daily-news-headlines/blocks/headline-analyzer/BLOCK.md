---
name: headline-analyzer
type: agent
model: sonnet
description: Analyze and categorize news headlines, rank by importance, output top headlines per category
author: jasem
version: 1.0.0

inputs:
  - name: raw_articles
    type: file
    format: json
    description: Raw articles JSON from news-fetcher

outputs:
  - name: report
    type: file
    format: markdown
    description: Categorized headlines report with links
  - name: structured
    type: file
    format: json
    description: Structured JSON of categorized headlines

config:
  - name: max_per_category
    type: number
    label: Max Headlines Per Category
    description: How many top headlines to include per category
    default: "5"
    required: false

env: []

data: {}
---

# headline-analyzer

Receives raw news articles from the fetcher, reads the configured categories, then:
1. Assigns each article to the best-matching category
2. Ranks articles within each category by importance/relevance
3. Picks the top N per category
4. Outputs a clean markdown report with headlines, sources, and links
5. Also outputs a structured JSON file for programmatic use
