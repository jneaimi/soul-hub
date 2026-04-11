---
name: repairer
type: script
runtime: python
description: Recalculate Total Spent, impute missing Quantity, drop rows missing all key fields
author: jasem
version: 1.0.0

inputs:
  - name: cleaned_csv
    type: file
    format: csv
    description: Partially cleaned CSV from the cleaner step

outputs:
  - name: repaired_csv
    type: file
    format: csv
    description: Final clean CSV with math fixed and incomplete rows dropped

config: []
env: []
data: {}
---

# repairer

Takes a partially cleaned CSV and repairs numeric data: recalculates Total Spent = Quantity x Price Per Unit where both exist, imputes missing Quantity as 1 when Price and Total exist, and drops rows where Item AND Quantity AND Price Per Unit are all missing.
