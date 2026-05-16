---
name: fetch-orgs
type: script
runtime: python
description: Fetch website content for known UAE SME organizations from config
author: jasem
version: 1.0.0

inputs:
  - name: known_orgs
    type: file
    format: json
    description: Seed list of known organizations from shared config

outputs:
  - name: fetched_data
    type: file
    format: json
    description: Raw website text + metadata for each org

config: []

env: []

data: {}
---

# fetch-orgs

Reads the known-orgs.json config, fetches each organization's website, and extracts raw text content. Outputs structured JSON with org metadata + scraped content for the agent to analyze.
