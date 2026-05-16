---
name: box-motif-finalizer
type: agent
runtime: claude
description: Renders the selected (category × direction) winners at print quality (Gemini Pro tier) and emits a finals manifest for the dieline exporter
author: jasem
version: 1.0.0
model: sonnet

inputs:
  - name: concepts_index
    type: file
    format: json
    description: concepts-index.json from box-motif-generator

outputs:
  - name: finals_index
    type: file
    format: json
    description: Manifest of high-resolution final motif files, one per (category × direction) selection

config:
  - name: model
    type: select
    label: Final render model
    description: pro = best detail (~$0.12 each), flash = cheap (~$0.04). Default pro since these go to print.
    options: [pro, flash]
    default: pro
    required: true
  - name: aspect
    type: select
    label: Aspect ratio
    description: Square 1:1 is the master motif; the dieline exporter rescales for the panel.
    options: ['1:1']
    default: '1:1'
    required: true

env:
  - name: GEMINI_API_KEY
    description: Google Gemini API key
    required: true

data: {}
---

# box-motif-finalizer

A pipeline-friendly fork of the global media-creator agent. Reads the concepts manifest plus the user's edited `selections.json`, and re-renders one final image per (category × direction) using the same prompt at the pro tier.

If the pro render drifts away from the picked concept, the user can re-run with the previous variant directly from the concepts folder — that fallback is preserved in `selections.json`.
