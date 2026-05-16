---
name: box-motif-generator
type: agent
runtime: claude
description: Generates concept motif images (no text) for every (category × direction) cell in the brief, saved into output/concepts/
author: jasem
version: 1.0.0
model: sonnet

inputs:
  - name: brief
    type: file
    format: markdown
    description: brief.md from box-motif-designer

outputs:
  - name: concepts_index
    type: file
    format: json
    description: Manifest of all generated concept files plus a default selections.json the user can edit before approval

config:
  - name: target_directions
    type: select
    label: Directions to render
    description: Render motifs for direction A, B, C, or all three
    options: [A, B, C, all]
    default: all
    required: true
  - name: variants_per_motif
    type: number
    label: Variants per (category × direction)
    description: How many concept images to generate per cell
    default: 3
    min: 1
    max: 5
    required: true
  - name: model
    type: select
    label: Image model tier
    description: flash = cheap concepts (~$0.04 each), pro = polished (~$0.12 each)
    options: [flash, pro]
    default: flash
    required: true

env:
  - name: GEMINI_API_KEY
    description: Google Gemini API key for image generation
    required: true

data: {}
---

# box-motif-generator

A pipeline-friendly fork of the global media-generator agent, scoped to one job: read the upstream brief, extract every literal generation prompt (one per category × direction), and produce N concept images per cell using `generate_media.py`.

Saves each image to `$PIPELINE_DIR/output/concepts/{category}__{direction}__v{N}.png`. Writes a `concepts-index.json` manifest plus a default `selections.json` (variant 0 for every cell) that the user can edit during the approval gate before the finalizer runs.

## What this agent does NOT do
- It never invents prompts — it only executes the prompts the designer wrote.
- It never adds text, logos, NOMAD wordmarks, or any typography to images.
- It never re-renders successful images on retry — only failed cells.
