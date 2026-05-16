---
name: report-builder
type: script
runtime: python
description: Generate a cafe guide with top picks, best value, hidden gems, deals, and warnings
author: jasem
version: 1.0.0

inputs:
  - name: scored-cafes
    type: file
    format: json
    description: Scored cafe data from deal-analyzer

outputs:
  - name: report
    type: file
    format: markdown
    description: Cafe guide with top picks, best value, hidden gems, deals, skip list, and quick reference table

config: []

env: []
---

# report-builder

Takes analyzed cafe data and generates a scannable cafe guide. Sections: At a Glance (insights), Top Picks (highest rated), Best Value (cheap + good), Hidden Gems (high rated, few reviews), Deals & Offers, Skip These (warnings), and a Quick Reference table.
