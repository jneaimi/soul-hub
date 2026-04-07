---
name: strategist
type: agent
runtime: claude
description: Weekly agent that identifies monetizable business opportunities from accumulated market intelligence
author: jasem
version: 1.0.0
model: sonnet

inputs:
  - name: prep_file
    type: file
    format: markdown
    description: Strategist prep file with accumulated intelligence summary
  - name: market_context
    type: file
    format: markdown
    description: Market context with GCC sectors, audience, relevance signals
    default: config/market-context.md
  - name: brand_assets
    type: file
    format: markdown
    description: Brand assets for leverage scoring
    default: config/brand-assets.md

outputs:
  - name: brief
    type: file
    description: Business Opportunity Brief in markdown

config:
  - name: lookback_weeks
    type: number
    default: 4
    min: 1
    max: 12
    label: Lookback weeks
    description: How many weeks of accumulated intelligence to analyze
  - name: act_now_threshold
    type: number
    default: 24
    min: 16
    max: 36
    label: ACT NOW threshold
    description: Minimum score for ACT NOW classification
  - name: max_opportunities
    type: number
    default: 10
    min: 1
    max: 25
    label: Max opportunities
    description: Maximum number of opportunities to include in the brief

env:
  - name: STRATEGIST_MODEL
    description: Override model for the Strategist agent
    required: false

data:
  requires: [findings, market_scores, opportunities]
  produces: [opportunities]
  database: signals.db
---

# Strategist

The Strategist (المستشار) — a business intelligence agent that reads weeks of accumulated market intelligence, identifies patterns that represent monetizable opportunities, scores them by feasibility and market potential, and produces a Business Opportunity Brief.

## How it works
1. Reads config files (strategist-config, market-context, brand-assets)
2. Queries accumulated findings (2-4 weeks)
3. Detects patterns (persistence, clustering, convergence, asset-market fit)
4. Scores and classifies opportunities (6 categories)
5. Matches against brand assets (leverage scoring)
6. Writes the Business Opportunity Brief
7. Stores opportunities in DB

## Files
- `agent.md` — full agent instructions
- `BLOCK.md` — this manifest
