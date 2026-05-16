---
name: quality-checker
type: script
description: Score data quality 0-100, fix remaining issues in a single pass
author: jasem
version: 1.0.0

inputs:
  - name: repaired_csv
    type: file
    format: csv
    description: CSV data to check and refine

outputs:
  - name: refined_csv
    type: file
    format: csv
    description: Refined CSV with quality improvements applied

config: []
env: []
data: {}
---

# quality-checker

Reads a CSV, scores data quality (completeness, consistency, validity) on a 0-100 scale. If score < 90, fixes remaining issues by imputing missing values with median/mode, normalizing formats, and removing duplicates. Outputs the improved CSV and a quality verdict line.
