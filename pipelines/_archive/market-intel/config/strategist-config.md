---
type: config
agent: strategist
created: 2026-03-26
tags: [signal-forge, strategist, config]

# Analysis window
lookback_weeks: 4              # How far back to look for patterns
min_persistence_days: 7        # Pain point must appear across 7+ days to qualify
min_findings_for_pattern: 3    # Minimum related findings to call it a pattern

# Opportunity categories
categories:
  - product       # Validated pain → tool/SaaS
  - service       # GCC-specific need → consulting/implementation
  - training      # Repeated "how do I" → workshop/course
  - partnership   # Tool + market need converge → joint venture
  - brand         # Content gap + expertise → authority positioning
  - community     # Recurring audience segment → group/newsletter

# Scoring thresholds
scoring:
  act_now_threshold: 24    # Score >= 24 → start this week
  develop_threshold: 16    # Score 16-23 → investigate further
  max_act_now: 3           # Cap recommendations per tier
  max_develop: 5

# Output limits
output:
  max_opportunities: 10    # Total across all tiers
  include_revenue_estimate: true
  include_first_step: true
  include_risk_assessment: true

# Budget
budget_per_run: 1.50       # Reads DB only, no API calls
---

# Strategist Config

Configuration for The Strategist (المستشار) — Pipeline Step 5. Runs weekly after the Miner `--weekly` report.

## Scoring Formula

Each opportunity is scored across 6 factors:

| Factor | Weight | Values |
|--------|--------|--------|
| Pain persistence | ×3 | 3+ weeks=3, 2 weeks=2, 1 week=1 |
| Market size signal | ×3 | high engagement + GCC high=3, medium=2, low=1 |
| Competitive gap | ×2 | no existing solution=3, few=2, many=0 |
| Brand asset leverage | ×2 | existing asset matches=3, partial=1, none=0 |
| Time to revenue | ×1 | immediate=3, 1-3 months=2, 6+ months=1 |
| Effort to execute | ×1 | low effort=3, medium=2, high=1 |

**Max score: 36**

**Tiers:**
- ACT NOW ≥ 24 → strong evidence, start this week
- DEVELOP 16-23 → worth investigating, needs validation
- WATCH < 16 → emerging signal, keep accumulating

## Category Definitions

| Category | Signal pattern | Revenue model |
|----------|---------------|---------------|
| **product** | Persistent pain + no tool exists | SaaS, one-time purchase, freemium |
| **service** | GCC-specific pain + no local provider | Consulting retainer, project-based |
| **training** | "How do I" signals + framework match | Workshop ($2-5K/seat), online course |
| **partnership** | Tool maker + market need converge | Joint content, integration, referral |
| **brand** | Content gap + your expertise | Authority → leads → all other categories |
| **community** | Recurring audience segment | Newsletter (free→paid), private group, events |

## Tuning

- **Too many ACT NOW?** Raise `act_now_threshold` to 26
- **Missing opportunities?** Lower `min_persistence_days` to 5
- **Wider patterns?** Increase `lookback_weeks` to 6
- **Focused on near-term?** Set `time_to_revenue` weight higher in agent prompt
