---
name: compile-report
type: script
runtime: python
description: Compile all research outputs into a single final intelligence report
author: jasem
version: 1.0.0

inputs:
  - name: org_landscape
    type: file
    format: json
    description: Organization landscape from discover-orgs
  - name: ai_analysis
    type: file
    format: markdown
    description: AI programs analysis
  - name: leads
    type: file
    format: json
    description: Extracted leads

outputs:
  - name: final_report
    type: file
    format: markdown
    description: Combined intelligence report with all sections

config: []

env: []

data: {}
---

# compile-report

Compiles all upstream outputs (org landscape, AI analysis, leads, pitch brief) into a single structured final report with table of contents and cross-references.
