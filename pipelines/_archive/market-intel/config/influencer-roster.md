---
type: reference
created: 2026-03-26
tags: [signal-forge, influencers, content-pipeline]
lookback_days: 3
---

# Influencer Roster

Managed list of influencers tracked by The Scout. Edit this table to add/remove influencers — the script (`scout_run.py`) reads it fresh every run.

## Active Roster

| Handle          | Platform | Focus                                           | Why Follow                                       |
| --------------- | -------- | ----------------------------------------------- | ------------------------------------------------ |
| stephengpope    | tiktok   | AI automation, business AI, no-code tools       | Practical AI business use cases, large audience  |
| Stephen G. Pope | youtube  | AI automation, business AI, coding tools        | Long-form deep dives, comments for pain points   |
| chase_ai_       | tiktok   | AI tools, workflows, productivity               | Trending AI tools coverage, high engagement      |
| Chase AI        | youtube  | Claude Code, AI workflows, tutorials            | Detailed tutorials, viewer questions in comments |
| marcinteodoru   | tiktok   | AI strategy, enterprise AI, future of work      | Strategic AI thinking, enterprise perspective    |
| Marcin AI       | youtube  | AI agents, vibe coding, enterprise AI           | Longer strategic content, comment discussions    |
| parthknowsai    | tiktok   | AI tutorials, tool comparisons, how-tos         | Tutorial-style content, broad tool coverage      |
| Parthknowsai    | youtube  | AI tools, model comparisons, deep analysis      | 40K-220K views, rich comment threads             |
| sabrina_ramonov | tiktok   | AI thinking, productivity, mindset shifts       | Closest to our framework angle, viral content    |
| Sabrina Ramonov | youtube  | AI wealth creation, productivity, learning      | 42K-74K views, engaged audience comments         |
| nate.b.jones    | tiktok   | AI development, coding with AI, developer tools | Developer-focused AI content, technical depth    |
| Nate B Jones    | youtube  | AI news, strategy, daily analysis               | 23K views, strategic commentary in comments      |

## How to Add an Influencer

Add a row to the table above with:
- **Handle**: Username on the platform (no @ prefix)
- **Platform**: One of: `tiktok`, `twitter`, `youtube`, `linkedin`, `instagram`, `reddit`
- **Focus**: What they talk about (helps downstream analysis)
- **Why Follow**: Why their signal matters for our content

The Scout syncs this table to the database on every run. New entries are added automatically. Removed entries stay in the DB (marked inactive) for historical data.
