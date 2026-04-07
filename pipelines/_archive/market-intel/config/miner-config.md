---
type: reference
created: 2026-03-26
tags: [signal-forge, miner, config]

# Analysis window
lookback_days: 7
min_posts_for_trend: 2
min_engagement_threshold: 500

# Pain point extraction
min_comment_words: 10
pain_point_keywords:
  - "struggle"
  - "problem"
  - "frustrated"
  - "can't figure"
  - "wish it"
  - "doesn't work"
  - "how do I"
  - "anyone know"
  - "hard to"
  - "confusing"
  - "broken"
  - "annoying"
  - "waste of time"
  - "gave up"
  - "not working"

# Content pillars (for angle mapping)
pillars:
  framework: "Bloom's AI Collaboration, trust boundary, 6 questions, cognitive levels"
  applied: "UAE/GCC industries — banking, aviation, real estate, government, logistics"
  trends: "AI adoption signals, tool comparisons, market shifts"

# Output
max_trending_topics: 5
max_pain_points: 10
include_source_urls: true
include_transcript_quotes: true

# Budget
budget_per_run: 0.50
---

# Miner Config

Configuration for The Miner (المنقّب). The Claude agent reads this file fresh on every run. When a data pack exists (`_prep/{DATE}-weekly-data-pack.md`), the agent reads that first and queries DB only for details not in the pack.

## Parameters

| Parameter | Default | What it controls |
|-----------|---------|-----------------|
| `lookback_days` | 7 | How far back to analyze posts |
| `min_posts_for_trend` | 2 | Minimum posts mentioning a topic to count as trend |
| `min_engagement_threshold` | 500 | Minimum likes to consider a post significant |
| `min_comment_words` | 10 | Skip shallow comments for pain point mining |
| `pain_point_keywords` | 15 patterns | Boost these in pain point detection |
| `pillars` | 3 pillars | Map trends to our content strategy |
| `max_trending_topics` | 5 | Top N trends per report |
| `max_pain_points` | 10 | Top N pain points per report |
| `include_source_urls` | true | Link every finding to source post |
| `include_transcript_quotes` | true | Pull direct quotes from transcripts |
| `budget_per_run` | 0.50 | Base budget (auto-scales with data volume) |

## Budget Scaling

The Miner budget **auto-scales** based on how much data it needs to read:

```
budget = base ($0.50)
       + market_signals × $0.003
       + transcripts × $0.05
       + $0.50 report writing headroom
       clamped to [$1.00, $5.00]
```

Examples:
- 7 posts, 0 signals, 3 transcripts → $1.15 → clamped to **$1.15**
- 7 posts, 500 signals, 3 transcripts → $2.65 → **$2.65**
- 20 posts, 1000 signals, 10 transcripts → $4.50 → **$4.50**

Override with `--budget N` flag if needed.

## Tuning

- **More noise?** Increase `min_posts_for_trend` to 3 and `min_engagement_threshold` to 1000
- **Deeper pain points?** Increase `min_comment_words` to 15 and add domain-specific keywords
- **Wider analysis?** Increase `lookback_days` to 14 for bi-weekly reports
- **Cheaper runs?** Set `include_transcript_quotes: false` to reduce token usage
