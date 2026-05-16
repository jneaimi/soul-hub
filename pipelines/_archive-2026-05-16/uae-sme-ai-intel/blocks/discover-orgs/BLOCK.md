---
name: discover-orgs
type: agent
model: sonnet
description: Review pre-fetched org data, fill gaps, discover missing UAE SME support organizations
author: jasem
version: 1.1.0

inputs:
  - name: fetched_data
    type: file
    format: json
    description: Pre-fetched website content for known organizations

outputs:
  - name: raw_landscape
    type: file
    format: json
    description: Raw organization landscape (cleaned by next step)

config:
  - name: focus_area
    type: text
    label: Focus Area
    description: Specific focus for discovery (e.g. AI adoption, digital transformation)
    default: "AI adoption for SMEs"
    required: true

env: []

data: {}
---

# discover-orgs

Reviews pre-fetched website data for known UAE SME support organizations. Enriches metadata, classifies AI relevance, and discovers any missing orgs via targeted web searches. Outputs raw JSON for the clean-output step to normalize.
