---
name: prepare-data
type: script
runtime: python
description: Clean, deduplicate, and structure comments into grouped AI-ready format with engagement stats and sentiment signals
author: jasem
version: 1.0.0

inputs:
  - name: comments
    type: file
    format: json
    description: Raw filtered comments from comment-collector step

outputs:
  - name: structured_comments
    type: file
    format: json
    description: Cleaned, grouped, and structured comments ready for AI pain analysis

config: []

env: []

data:
  requires: [comments]
  produces: [structured_comments]
---

# Prepare Data

Cleans and structures raw comments for the AI pain analyzer. Groups comments by trend/topic, removes near-duplicates, calculates engagement statistics per group, extracts key phrases via n-gram frequency, and computes sentiment signals (negative/positive/question/request counts). Outputs structured JSON optimized for LLM consumption.
