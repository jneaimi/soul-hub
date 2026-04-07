---
type: config
agent: content-forge
created: 2026-03-26
tags: [signal-forge, content-forge, config]

# Content pillars (aligned with miner-config.md)
content_pillars:
  - name: framework
    description: "AI implementation frameworks, governance, strategy, Bloom's model"
    keywords: [framework, governance, strategy, implementation, roadmap, trust, collaboration]
  - name: applied
    description: "Real-world AI use cases, tools, hands-on tutorials, GCC industries"
    keywords: [tutorial, how-to, tool, build, deploy, automate, banking, aviation, logistics]
  - name: trends
    description: "Emerging AI trends, market shifts, industry signals"
    keywords: [trend, emerging, shift, new, launch, announce, comparison, benchmark]

# Platform targets (only draft what's actionable NOW)
platforms: [linkedin]           # LinkedIn-only phase (weeks 1-12)
# platforms: [linkedin, twitter]        # Enable at week 13 (~2026-06-16)
# platforms: [linkedin, twitter, video]  # Enable when ready
languages: [en, ar]

# Platform rollout tracking
platform_phases:
  linkedin_start: 2026-03-24    # Week 1
  twitter_start: null            # Enable at week 13
  video_start: null              # Enable when ready

# Scoring thresholds
scoring:
  hot_threshold: 20         # Score >= 20 → HOT (full drafts)
  warm_threshold: 12        # Score 12-19 → WARM (linkedin + twitter only)
  max_hot: 3                # Max HOT items per run
  max_warm: 2               # Max WARM items per run

# Draft quality
drafts:
  video_max_seconds: 60
  twitter_max_tweets: 6
  linkedin_max_words: 300
  quality_threshold: 35     # Anti-slop score minimum (out of 50)

# Voice
voice:
  en: thought-leader         # Not news-reporter, not academic
  ar: warm-professional      # Brand voice from /arabic

# Arabic Voice Exemplar (MUST READ before writing any Arabic draft)
arabic_exemplar: "~/SecondBrain/02-areas/signal-forge/arabic-voice-exemplar.md"

# Article Radar (read from weekly Miner report)
article_radar:
  min_persistence_days: 3    # Topic must appear 3+ days
  min_pain_cluster: 2        # At least 2 related pain points
  min_article_score: 24      # Out of 36

# Schedule
schedule:
  runs_after: miner          # Always after Miner finishes
  lookback_findings: 1       # Days of findings to consider (1 = today only)
  include_promoted_seeds: true  # Seeds from previous days that gained evidence

# Budget
budget_menu_enrich: 0.75     # AI enrichment of content menu (titles, hooks, angles)
budget_per_draft: 1.50       # Per-item drafting via draft.sh / /draft
---

# Content Forge Config

Configuration for The Content Forge (صانع المحتوى) — Pipeline Step 4. Reads this file fresh on every run.

## Scoring Formula

Each finding is scored across 5 factors:

| Factor | Weight | Values |
|--------|--------|--------|
| Signal strength | ×3 | high=3, medium=2, low=1 |
| GCC relevance | ×3 | high=3, medium=2, low=1, none=0 |
| Source count | ×1 | ≥5 sources=3, 3-4=2, 1-2=1 |
| Pillar match | ×2 | exact=2, adjacent=1, none=0 |
| Has opportunity | ×1 | yes=2, no=0 |

**Max score: 30** (9 + 9 + 3 + 4 + 2 + article_candidate bonus 3 = 30)

**Tiers:**
- HOT ≥ 20 → Shown in menu with full editorial (titles, hooks EN+AR)
- WARM 12-19 → Shown in menu with summary
- SEED < 12 → Saved as idea JSON only

Drafting is on-demand via `draft.sh` or `/draft`. Only active platforms are drafted (currently LinkedIn EN+AR).

## Arabic Voice Rules (extracted from exemplar article)

The `arabic_exemplar` field above points to a reference article. The agent MUST read it
before writing any Arabic draft and match its quality and voice. Key patterns:

### Structure
1. **Open with concrete evidence** — a specific event, stat, or quote with exact numbers. Never open with abstraction.
2. **Short paragraphs** — 1-3 sentences. Max 4. Every paragraph earns its place.
3. **Evidence → interpretation** — state the fact first, then your take. Never reverse this.
4. **Imperatives at the close** — "اختر... أضف... أبقِ..." — direct, punchy, no hedging.
5. **Forward momentum** — each section builds on the last. No circling back.

### Language
6. **Active verbs** — "نشر", "حصد", "صُممت" — no passive constructions hiding the actor.
7. **Address the reader directly** — "أنت رأيت هذا النمط", "سير عملك" — second person, natural.
8. **One metaphor, then move on** — land it once ("سيارة رياضية بلا أحزمة أمان"), don't repeat or explain it.
9. **Specific numbers** — 182,000 views, 250,000 stars, 17 companies. Never "many" or "several".
10. **Clean MSA formality 3** — warm professional. No dialect in articles/LinkedIn. Light Khaleeji only in Twitter (formality 2).

### Absolute Prohibitions
11. **Zero throat-clearers** — never "في عالمنا اليوم", "مع التطور المتسارع", "في ظل التحولات"
12. **Zero emphasis crutches** — never "بلا شك", "من الواضح أن", "لا يمكن إنكار"
13. **Zero false agency** — never "يشهد القطاع تحولًا", "تتيح التقنية" — find the human actor
14. **Zero filler transitions** — never "بالإضافة إلى ذلك", "علاوة على ما سبق", "في هذا السياق"
15. **Zero rhetorical padding** — never "السؤال الحقيقي هو", "دعوني أكون صريحاً"

### Quality Test
Before saving any Arabic draft, check: "Does this read like the exemplar article?" If the
opening is abstract, if a paragraph exceeds 4 sentences, if a throat-clearer slipped in,
or if any sentence uses false agency — rewrite that section.

## Format Templates

### LinkedIn Post
- Hook (1 provocative line) → Body (2-3 paragraphs) → CTA → Hashtags
- Max 300 words. Links go in first comment, not in post body.

### Twitter Thread
- 4-6 tweets. First tweet stands alone as hook. Last tweet is CTA.
- Each tweet ≤ 280 chars.

### Video Script (60s)
- [0-5s] HOOK → [5-20s] PROBLEM → [20-40s] INSIGHT → [40-55s] SO WHAT → [55-60s] CTA

## Brand Asset Integration

The agent reads `brand-assets.md` and matches finding keywords to asset topics.
Max 1 asset reference per post. CTA goes in closer, never in hook.

## Article Radar

When the weekly Miner report includes an Article Radar section, Content Forge:
1. Reads article candidates scored READY (≥ 24)
2. Produces a structured outline + first draft (EN + AR)
3. Saves to `drafts/articles/`

## Tuning

- **Too many HOT items?** Raise `hot_threshold` to 22
- **Want more drafts?** Raise `max_hot` to 4 and `max_warm` to 3
- **Shorter threads?** Lower `twitter_max_tweets` to 4
- **Skip video scripts?** Remove `video` from `platforms`
