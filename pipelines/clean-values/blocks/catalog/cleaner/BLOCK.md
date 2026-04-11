---
name: cleaner
type: script
runtime: python
description: Replace ERROR/UNKNOWN with null, standardize Payment Method, parse dates to YYYY-MM-DD
author: jasem
version: 1.0.0

inputs:
  - name: csv_file
    type: file
    format: csv
    description: The dirty CSV file to clean

outputs:
  - name: cleaned_csv
    type: file
    format: csv
    description: Partially cleaned CSV with sentinel values removed and formats standardized

config: []
env: []
data: {}
---

# cleaner

Cleans sentinel values (ERROR, UNKNOWN) from a CSV, standardizes Payment Method to lowercase/trimmed, and parses dates to YYYY-MM-DD format (nulling invalid ones). Outputs a partially cleaned CSV.
