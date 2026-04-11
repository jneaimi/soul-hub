---
name: title-ranker
type: script
runtime: python
description: Rank influencer posts by total engagement and output the top N titles
author: jasem
version: 1.0.0

inputs:
  - name: posts
    type: file
    format: json
    description: Scanned posts from scan-posts step

outputs:
  - name: top_titles
    type: file
    format: json
    description: Top N titles ranked by total engagement with metadata

config: []
env: []

data:
  requires: [posts]
  produces: [top_titles]
---

# Title Ranker

Reads the scan-posts output, ranks all posts by total engagement (likes + comments + shares), and outputs the top N titles. The top N value is read from pipeline-settings.json (default: 3).
