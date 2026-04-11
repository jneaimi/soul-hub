---
name: pain-analyzer
type: agent
model: sonnet
description: Analyze filtered comments to extract pain points, group by theme, and generate a structured markdown report
author: jasem
version: 1.0.0

inputs:
  - name: comments
    type: file
    format: json
    description: Filtered comments from comment-collector step

outputs:
  - name: report
    type: file
    format: markdown
    description: Daily pain point analysis report

config:
  - name: target_region
    type: text
    label: Target Region
    description: Region context for the analysis
    required: true

env: []

data:
  requires: [comments]
  produces: [report]
---

# Pain Analyzer

AI agent that reads filtered comments from trending content, identifies recurring pain points and frustrations, groups them by theme, ranks by frequency, and outputs a structured markdown report. Works with any language — analyzes comments in their original language and presents findings in English.
