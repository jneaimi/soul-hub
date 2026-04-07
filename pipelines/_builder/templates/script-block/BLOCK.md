---
name: BLOCK_NAME
type: script
runtime: python
description: DESCRIPTION
author: jasem
version: 1.0.0

inputs:
  - name: INPUT_NAME
    type: file
    format: json
    description: INPUT_DESCRIPTION

outputs:
  - name: OUTPUT_NAME
    type: file
    description: OUTPUT_DESCRIPTION

config:
  - name: PARAM_NAME
    type: text
    label: PARAM_LABEL
    description: PARAM_DESCRIPTION
    default: DEFAULT_VALUE
    required: true

env: []

data: {}
---

# BLOCK_NAME

DESCRIPTION — what this block does, when to use it, and how it fits into a pipeline.
