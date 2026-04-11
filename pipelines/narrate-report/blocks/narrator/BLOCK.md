---
name: narrator
type: agent
model: sonnet
description: Transform a structured quality report into a stakeholder-friendly narrative with actionable insights
author: jasem
version: 1.0.0

inputs:
  - name: quality_report
    type: file
    format: markdown
    description: Markdown quality report from the reporter block
  - name: repaired_csv
    type: file
    format: csv
    description: Final repaired CSV to scan for semantic anomalies

outputs:
  - name: narrated_report
    type: file
    format: markdown
    description: Human-readable narrative summarizing data quality, key findings, and recommendations

config: []
env: []
data: {}
---

# narrator

Reads the structured quality report and repaired CSV, then writes a stakeholder-friendly narrative that highlights what happened, what matters, and what to do next.
