---
name: reporter
type: script
runtime: python
description: Compare before/after validation data and generate a markdown quality report
author: jasem
version: 1.1.0

inputs:
  - name: validation_report
    type: file
    format: json
    description: Schema validation report from validate-schema pipeline
  - name: repaired_csv
    type: file
    format: csv
    description: Final repaired CSV from repair-data pipeline

outputs:
  - name: quality_report
    type: file
    format: markdown
    description: Markdown report with rows recovered/dropped, quality score, top anomalies

config: []
env: []
data: {}
---

# reporter

Reads the validation report (before) and repaired CSV (after), compares them, and generates a markdown quality report covering: rows recovered, rows dropped, data quality score, and top anomalies.
