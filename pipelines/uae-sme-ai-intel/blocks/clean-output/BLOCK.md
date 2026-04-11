---
name: clean-output
type: script
runtime: python
description: Validate and normalize the discover-orgs agent output into clean schema
author: jasem
version: 1.0.0

inputs:
  - name: raw_orgs
    type: file
    format: json
    description: Raw agent output with organization data

outputs:
  - name: org_landscape
    type: file
    format: json
    description: Clean, validated organization landscape JSON

config: []

env: []

data: {}
---

# clean-output

Validates and normalizes the agent's JSON output. Deduplicates orgs, enforces schema, fills missing fields with defaults, and produces a clean JSON file for downstream steps.
