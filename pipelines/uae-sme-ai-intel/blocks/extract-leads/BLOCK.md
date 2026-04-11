---
name: extract-leads
type: agent
model: sonnet
description: Extract actionable leads, RFPs, and partnership opportunities from AI program analysis
author: jasem
version: 1.0.0

inputs:
  - name: ai_analysis
    type: file
    format: markdown
    description: AI programs analysis from analyze-ai-programs step

outputs:
  - name: leads
    type: file
    format: json
    description: Prioritized list of actionable leads and opportunities

config:
  - name: min_priority
    type: select
    label: Minimum Priority
    description: Filter leads by minimum priority level
    default: medium
    required: true
    options: [high, medium, low]

env: []

data: {}
---

# extract-leads

Extracts actionable leads from the AI programs analysis — RFPs, vendor registration opportunities, partnership programs, upcoming events, and contact points. Prioritizes by opportunity strength.
