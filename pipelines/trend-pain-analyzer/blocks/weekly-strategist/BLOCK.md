---
name: weekly-strategist
type: agent
model: sonnet
description: Analyze a week of accumulated data to identify recurring patterns, emerging trends, and business opportunities
author: jasem
version: 1.0.0

inputs:
  - name: weekly_data
    type: file
    format: json
    description: Aggregated weekly data from weekly-extractor

outputs:
  - name: report
    type: file
    format: markdown
    description: Weekly opportunities and strategy report

config:
  - name: target_region
    type: text
    label: Target Region
    description: Region context for opportunity analysis
    required: true

env: []

data:
  requires: [weekly_data]
  produces: [report]
---

# Weekly Strategist

AI agent that reads a week's worth of accumulated trend data, pain points, and engagement signals. Identifies recurring patterns, emerging trends, and actionable business opportunities. Outputs a strategic weekly report.
