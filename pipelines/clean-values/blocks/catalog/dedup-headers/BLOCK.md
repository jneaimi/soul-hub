---
name: dedup-headers
type: script
runtime: python
description: Remove duplicate header rows from a merged CSV (artifact of chunk concat)
author: jasem
version: 1.0.0

inputs:
  - name: csv_file
    type: file
    format: csv
    description: Merged CSV that may contain duplicate header rows

outputs:
  - name: clean_csv
    type: file
    format: csv
    description: CSV with exactly one header row

config: []
env: []
data: {}
---

# dedup-headers

Strips duplicate header rows from a CSV file produced by concatenating chunked outputs. Each chunk includes its own header, so a concat merge of N chunks produces N-1 extra header rows embedded as data. This block removes them.
