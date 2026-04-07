---
type: reference
created: 2026-03-26
tags:
  - signal-forge
  - prospector
  - config
mode: auto
max_topics: 2
pinned_topic: AI agents in GCC
platforms:
  - twitter
  - reddit
  - youtube
  - linkedin
  - news
  - forums
searches_per_platform: 1
include_arabic_search: true
min_engagement_filter: 50
validate_pain_points: true
max_pain_points_per_topic: 3
include_competing_content: true
include_audience_segments: true
include_gcc_signals: true
include_source_quotes: true
max_quotes_per_section: 5
---

# Prospector Config

Configuration for The Prospector (المنقّب الميداني). Now a deterministic Python script (`prospector_run.py`) — reads this config, searches platforms, stores in DB. No AI agent cost.

## Mode

| Mode     | Behavior                                 |
| -------- | ---------------------------------------- |
| `auto`   | Top N from Miner + optional pinned topic |
| `manual` | Only the topic passed via `--topic` flag |

### Auto mode (default)
Picks top `max_topics` from the Miner report by signal strength. If `pinned_topic` is set, it's always added as an extra topic.

```yaml
mode: auto
max_topics: 2                              # 2 auto from Miner
pinned_topic: "AI agents in GCC banking"   # +1 pinned = 3 total
```

Set `pinned_topic: ""` to disable — only the 2 auto topics run.

### Manual mode
Pass `--topic "specific topic"` to the runner script. Ignores auto-ranking and pinned topic. Researches only the specified topic.

## Parameters

| Parameter | Default | What it controls |
|-----------|---------|-----------------|
| `mode` | auto | Topic selection mode (auto / manual) |
| `max_topics` | 2 | Top N topics from Miner in auto mode |
| `pinned_topic` | "" | Always-on topic (empty = disabled) |
| `platforms` | all 6 | Which platforms to search per topic |
| `searches_per_platform` | 1 | API pages per platform per topic |
| `include_arabic_search` | true | Search Arabic queries alongside English |
| `min_engagement_filter` | 50 | Minimum engagement to include results |
| `validate_pain_points` | true | Cross-check Miner's pain points against market |
| `max_pain_points_per_topic` | 3 | Pain points to validate per topic |
| `include_competing_content` | true | Scan for existing content on each topic |
| `include_audience_segments` | true | Identify who cares about each topic |
| `include_gcc_signals` | true | Search for GCC/UAE specific angles |
| `include_source_quotes` | true | Pull direct quotes from search results |
| `max_quotes_per_section` | 5 | Cap quotes per section to keep report focused |

## Tuning

- **Cheaper runs:** Remove expensive platforms (news $0.008, forums $0.008), keep reddit ($0.003) + youtube (free)
- **Deeper research:** Increase `searches_per_platform: 2`
- **GCC focus:** Set `include_gcc_signals: true` and `include_arabic_search: true`
- **Quick validation:** Set `max_topics: 1`, remove forums/news from platforms
- **Manual deep-dive:** `./prospector.sh --topic "specific topic"`

**Note:** Parameters like `validate_pain_points`, `include_competing_content`, `include_audience_segments`, `include_source_quotes`, `max_quotes_per_section` were used by the old Claude agent. The Python script (`prospector_run.py`) reads `mode`, `max_topics`, `pinned_topic`, `platforms`, and `include_arabic_search`. Other parameters are retained for potential future use.
