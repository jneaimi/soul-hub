---
name: output-cleaner
type: script
runtime: python
description: Extract and normalize JSON from agent output that may contain markdown, prose, or unexpected structures
author: jasem
version: 1.0.0

inputs:
  - name: raw-agent-output
    type: file
    format: json
    description: Raw agent output file — may be valid JSON, JSON wrapped in markdown fences, or prose with embedded JSON

outputs:
  - name: clean-output
    type: file
    format: json
    description: Clean JSON with normalized cafe structure ready for report-builder

config: []

env: []
---

# output-cleaner

Sanitizes agent output into valid, normalized JSON for downstream script blocks. Handles three failure modes:
1. Agent wraps JSON in markdown code fences
2. Agent adds prose/commentary around the JSON
3. Agent uses an unexpected key structure

Extracts the JSON, validates it, and passes it through unchanged if it already matches the expected format.
