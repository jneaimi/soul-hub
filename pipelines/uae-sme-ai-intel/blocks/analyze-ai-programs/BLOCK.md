---
name: analyze-ai-programs
type: agent
model: sonnet
description: Deep analysis of AI adoption programs and support offered by each UAE SME organization
author: jasem
version: 1.0.0

inputs:
  - name: org_landscape
    type: file
    format: json
    description: List of discovered organizations from discover-orgs step

outputs:
  - name: ai_analysis
    type: file
    format: markdown
    description: Deep analysis of AI programs, support types, and gaps per organization

config:
  - name: analysis_depth
    type: select
    label: Analysis Depth
    description: How deep to research each organization
    default: deep
    required: true
    options: [quick, deep]

env: []

data: {}
---

# analyze-ai-programs

For each discovered UAE SME support organization, performs deep research into their AI adoption initiatives, technology support programs, supplier ecosystems, and identifies gaps and opportunities.
