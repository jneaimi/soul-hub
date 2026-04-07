---
name: miner
type: agent
runtime: claude
description: Analyzes raw data (posts, market signals, transcripts), extracts findings, scores against target markets, and stores in the intelligence layer
author: jasem
version: 1.0.0
model: sonnet

inputs:
  - name: database
    type: file
    format: sqlite
    description: SQLite database with posts, market signals, comments, transcripts
  - name: config_file
    type: file
    format: markdown
    description: Miner config with lookback, thresholds, pillars, keywords
    default: config/miner-config.md
  - name: market_context
    type: file
    format: markdown
    description: Market context with active markets, sectors, relevance signals
    default: config/market-context.md

outputs:
  - name: report
    type: file
    description: Daily brief or weekly report in markdown

config:
  - name: mode
    type: select
    options: [daily, weekly, full]
    default: daily
    label: Analysis mode
    description: daily = unmined data only, weekly = full lookback window, full = all data
  - name: lookback_days
    type: number
    default: 7
    min: 1
    max: 30
    label: Lookback days
    description: How many days of data to analyze
  - name: include_transcripts
    type: toggle
    default: true
    label: Include transcripts
    description: Analyze YouTube transcripts for deeper insights

env:
  - name: MINER_MODEL
    description: Override model for the Miner agent
    required: false

data:
  requires: [posts, market_signals, comments]
  produces: [findings, market_scores, opportunities, analysis_runs]
  database: signals.db
---

# Miner

The Miner (المنقّب) — a market intelligence agent that analyzes raw data, extracts structured findings, scores them against target markets, identifies business opportunities, and stores everything in the database.

## How it works
1. Reads miner config + market context
2. Logs analysis run in DB
3. Queries unmined data (daily) or full window (weekly/full)
4. Extracts findings: trends, pain points, content gaps, audience insights, market shifts
5. Scores each finding against active target markets (GCC)
6. Identifies business opportunities from findings
7. Stores findings + scores + opportunities in DB
8. Marks analyzed data as mined
9. Writes daily brief or weekly comprehensive report

## Files
- `agent.md` — full agent instructions
- `BLOCK.md` — this manifest
