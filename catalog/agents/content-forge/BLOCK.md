---
name: content-forge
type: agent
runtime: claude
description: Reads today's intelligence, scores and ranks findings, writes bilingual content drafts (EN + AR) with anti-slop quality
author: jasem
version: 1.0.0
model: sonnet

inputs:
  - name: prep_file
    type: file
    format: markdown
    description: Content prep file from the content-scorer block
  - name: brand_assets
    type: file
    format: markdown
    description: Brand assets file for CTA matching
    default: config/brand-assets.md
  - name: config_file
    type: file
    format: markdown
    description: Content Forge config with platforms, scoring, voice settings
    default: config/content-forge-config.md

outputs:
  - name: content_menu
    type: file
    description: Content menu with scored and ranked findings
  - name: drafts
    type: file
    description: Platform-specific bilingual drafts directory

config:
  - name: platforms
    type: multiselect
    options: [linkedin, twitter, video]
    default: [linkedin]
    label: Target platforms
    description: Which platforms to generate drafts for
  - name: max_hot
    type: number
    default: 3
    min: 1
    max: 5
    label: Max HOT items
    description: Maximum number of HOT-tier items to draft
  - name: languages
    type: multiselect
    options: [en, ar]
    default: [en, ar]
    label: Languages
    description: Which languages to generate drafts in

env:
  - name: CONTENT_FORGE_MODEL
    description: Override model for the Content Forge agent
    required: false

data:
  requires: [findings, market_scores]
  produces: []
  database: signals.db
---

# Content Forge

The Content Forge (صانع المحتوى) — a bilingual content creation agent that reads today's intelligence, ranks findings by content potential, matches against brand assets, and writes publication-ready drafts in English and Arabic.

## How it works
1. Reads config files (content-forge-config, market-context, brand-assets, brand-voice)
2. Queries today's findings from the database
3. Scores and ranks each finding (HOT / WARM / SEED)
4. Matches findings to brand assets
5. Checks for article candidates (from weekly Miner Article Radar)
6. Writes the content menu
7. Writes English drafts (stop-slop rules)
8. Writes Arabic drafts (anti-slop + brand voice rules)
9. Saves seeds + summary

## Files
- `agent.md` — full agent instructions
- `BLOCK.md` — this manifest
