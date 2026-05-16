---
name: splitter
type: script
runtime: python
description: Split a CSV file into smaller chunk files using csv_splitter component
author: jasem
version: 1.0.0

inputs:
  - name: csv_file
    type: file
    format: csv
    description: The CSV file to split

outputs:
  - name: chunks_dir
    type: file
    format: csv
    description: Directory of chunk CSV files

config:
  - name: chunk_size
    type: number
    label: Chunk Size
    description: Number of rows per chunk
    default: 2000
    required: true
  - name: format
    type: select
    label: Output Format
    description: Format for chunk files
    default: csv
    required: true
    options: [csv, json]

env: []
data: {}
---

# splitter

Splits a large CSV file into smaller chunks for parallel processing. Uses the csv_splitter component from _builder/components/.
