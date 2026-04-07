---
type: reference
created: 2026-03-26
tags: [signal-forge, market-context, target-markets]

# Active target markets
active_markets:
  - gcc

# Market definitions
markets:
  gcc:
    name: "Gulf Cooperation Council"
    countries: ["UAE", "Saudi Arabia", "Qatar", "Kuwait", "Bahrain", "Oman"]
    lead_country: "UAE"
    sectors: ["banking", "aviation", "real estate", "government", "logistics", "fintech", "oil & gas"]
    audience: ["CTOs", "CIOs", "digital transformation leads", "enterprise architects", "startup founders", "government IT teams"]
    language_primary: "MSA (Modern Standard Arabic)"
    language_social: "MSA + light Khaleeji"
    relevance_signals:
      - "UAE Smart Government"
      - "Saudi Vision 2030"
      - "DIFC fintech hub"
      - "Abu Dhabi AI strategy"
      - "Dubai Digital Authority"
      - "NEOM"
      - "GCC digital transformation"
    relevance_threshold: medium
---

# Market Context

Target market definitions for Signal Forge. Read by the Miner and any downstream agent that needs market context.

## How Markets Work

Each market is a **lens** applied to every finding. The Miner assesses: "Is this finding relevant to this market? How? For whom?"

### Active Markets

Only markets listed in `active_markets` are scored. Add a market to the list to activate it.

### Adding a New Market

Add a new entry under `markets:` with the same structure:

```yaml
markets:
  sea:
    name: "Southeast Asia"
    countries: ["Singapore", "Indonesia", "Malaysia", "Thailand", "Vietnam", "Philippines"]
    lead_country: "Singapore"
    sectors: ["fintech", "e-commerce", "logistics", "government"]
    audience: ["Startup CTOs", "VCs", "Government tech teams"]
    language_primary: "English"
    relevance_signals: ["Smart Nation Singapore", "Indonesia digital economy"]
    relevance_threshold: medium
```

Then add `sea` to `active_markets`.

### Relevance Scoring

| Score | Meaning |
|-------|---------|
| `high` | Direct impact on target market sectors/audience |
| `medium` | Applicable with adaptation (e.g., global AI trend with GCC deployment angle) |
| `low` | Tangentially relevant, no specific market angle |
| `none` | Not relevant to this market |

Findings below `relevance_threshold` are stored but deprioritized in reports.
