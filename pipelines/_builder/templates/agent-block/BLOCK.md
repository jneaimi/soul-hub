---
name: AGENT_NAME
type: agent
model: sonnet
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

# AGENT_NAME

DESCRIPTION — what this agent does and when to use it.
