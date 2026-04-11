---
name: deal-analyzer
type: agent
model: sonnet
description: Analyze cafe reviews to detect deals, discounts, happy hours, and special offers
author: jasem
version: 1.0.0

inputs:
  - name: cafes
    type: file
    format: json
    description: Array of cafe objects with reviews from cafe-finder

outputs:
  - name: scored-cafes
    type: file
    format: json
    description: Cafes scored and annotated with detected deals and offer summaries

config: []

env: []
---

# deal-analyzer

AI agent that reads cafe data with reviews, extracts mentions of discounts, happy hours, BOGO offers, loyalty cards, home-cafe pricing, and special promotions. Scores each cafe by deal quality (0-10) and produces a summary of detected offers.
