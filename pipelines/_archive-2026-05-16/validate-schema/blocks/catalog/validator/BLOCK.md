---
name: validator
type: script
runtime: python
description: Read a CSV, check columns exist, detect data types, count issues per column (nulls, ERRORs, UNKNOWNs, type mismatches)
author: jasem
version: 1.0.0

inputs:
  - name: csv_file
    type: file
    format: csv
    description: The dirty CSV file to validate

outputs:
  - name: validation_report
    type: file
    format: json
    description: JSON report with issue counts per column and per issue type

config: []
env: []
data: {}
---

# validator

Reads a CSV file and produces a schema validation report. Checks that expected columns exist, detects data types, and counts issues per column: nulls/empty, ERROR values, UNKNOWN values, and type mismatches (e.g. non-numeric Quantity).
