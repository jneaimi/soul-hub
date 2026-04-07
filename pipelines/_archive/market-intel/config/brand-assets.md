---
type: config
agent: content-forge
created: 2026-03-26
updated: 2026-03-26
tags: [signal-forge, content-forge, brand-assets]
---

# Brand Asset Registry

The Content Forge and Strategist read this file to match findings against existing brand assets.
When a finding's keywords overlap with an asset's topics, the agent weaves a natural reference
into the draft (Content Forge) or scores leverage (Strategist).

## Rules

1. **Max 1 asset reference per post** — more than one feels like an ad
2. **CTA goes in the closer, not the hook** — hook is for the insight
3. **LinkedIn: "link in first comment"** — algorithm penalizes links in posts
4. **Twitter: link in last tweet** — same reason
5. **Articles: inline links are fine** — articles naturally reference tools
6. **No match = no mention** — never force an asset into an unrelated post
7. **Arabic CTA is a rewrite, not translation** — matches /arabic brand voice
8. **Prioritize tools > framework > articles** — tools have the strongest CTA

## Assets

```yaml
# ════════════════════════════════════════
# TOOLS (interactive, highest CTA value)
# ════════════════════════════════════════

assets:
  - name: AI Tool Picker
    type: tool
    url: "https://jneaimi.com/en/ai-picker"
    topics: [AI tools, model comparison, choosing AI, LLM benchmarks, pricing, API cost, model selection, decision fatigue, tool overload, subscription waste, Arabic support]
    cta_en: "Not sure which AI tool fits? I built a quiz that recommends from 120+ tools in 60 seconds — link in first comment"
    cta_ar: "مو متأكد أي أداة ذكاء اصطناعي تناسبك؟ بنيت اختبار يرشّحلك من ١٢٠+ أداة في ٦٠ ثانية — الرابط في أول تعليق"

  - name: /think Skill (Open Source)
    type: tool
    url: "https://jneaimi.com/en/insights/blooms-ai-think-skill"
    github: "https://gist.github.com/jneaimi/b84f370e9270a9e61e12502a6d9fd884"
    topics: [Claude Code, open source, structured thinking, AI collaboration, developer tools, skill, evaluation first]
    cta_en: "I open-sourced a /think skill for Claude Code — install it in 2 minutes and start every AI session with structured evaluation"
    cta_ar: "أطلقت أداة /think مفتوحة المصدر لـ Claude Code — ثبّتها في دقيقتين وابدأ كل جلسة بتقييم منظّم"

# ════════════════════════════════════════
# FRAMEWORK (flagship IP)
# ════════════════════════════════════════

  - name: Bloom's AI Collaboration Framework
    type: framework
    url: "https://jneaimi.com/en/insights/blooms-ai-framework"
    topics: [decision making, thinking framework, AI collaboration, planning, evaluate before building, cognitive levels, trust boundary, Bloom's Taxonomy, human-AI partnership, 6 questions]
    cta_en: "This maps to Bloom's AI Collaboration Framework — start at Level 5 (Evaluate) before you build. Link in first comment"
    cta_ar: "هذا يرتبط بإطار بلوم للتعاون مع الذكاء الاصطناعي — ابدأ بالتقييم قبل البناء. الرابط في أول تعليق"

# ════════════════════════════════════════
# ARTICLES (reference in relevant drafts)
# ════════════════════════════════════════

  - name: "40+ AI Tools and You Still Can't Choose"
    type: article
    url: "https://jneaimi.com/en/insights/ai-tool-decision-fatigue"
    date: 2026-03-22
    topics: [AI decision fatigue, tool overload, tool selection, subscription waste, analysis paralysis]
    cta_en: "I analyzed 2,789 posts on this exact problem — the data is clear. Full article in first comment"
    cta_ar: "حللت ٢٧٨٩ منشور عن هذه المشكلة تحديدًا — البيانات واضحة. المقال كامل في أول تعليق"

  - name: "GCC Enterprise Agentic AI Decision Framework"
    type: article
    url: "https://jneaimi.com/en/insights/gcc-enterprise-agentic-framework"
    date: 2026-03-22
    topics: [agentic AI, enterprise, GCC, build buy wait, data residency, sovereign AI, Arabic NLP, decision framework]
    cta_en: "I wrote a three-axis decision framework for GCC enterprises evaluating agentic AI — link in first comment"
    cta_ar: "كتبت إطار قرار بثلاثة محاور للمؤسسات الخليجية التي تقيّم الوكلاء الأذكياء — الرابط في أول تعليق"

  - name: "Enterprise AI Has Entered the Trust Era"
    type: article
    url: "https://jneaimi.com/en/insights/enterprise-ai-governance-trust-era"
    date: 2026-03-20
    topics: [AI governance, enterprise trust, accountability, compliance, human oversight, AI agents, sandboxing, trust infrastructure]
    cta_en: "AI capability has outpaced AI trust — I wrote about the five governance questions every enterprise must answer"
    cta_ar: "قدرات الذكاء الاصطناعي تجاوزت الثقة — كتبت عن خمسة أسئلة حوكمة يجب على كل مؤسسة الإجابة عليها"

  - name: "The AI Thinking Gap"
    type: article
    url: "https://jneaimi.com/en/insights/ai-thinking-gap"
    date: 2026-03-17
    topics: [AI thinking gap, cognitive frameworks, Bloom's Taxonomy, trust boundary, enterprise AI ROI, human-AI partnership]
    cta_en: "Your org has the AI tools — does it have the thinking? I wrote about why frameworks matter more than features"
    cta_ar: "مؤسستك عندها أدوات الذكاء الاصطناعي — هل عندها التفكير؟ كتبت ليش الأطر أهم من المميزات"

  - name: "Human-AI Collaboration Landscape: 419 Posts Analyzed"
    type: article
    url: "https://jneaimi.com/en/insights/human-ai-collaboration-landscape"
    date: 2026-03-14
    topics: [market research, AI collaboration, prompt engineering, content gap, platform analysis, collaboration landscape]
    cta_en: "Everyone teaches AI tools — almost nobody teaches AI thinking. I analyzed 419 posts to prove it"
    cta_ar: "الكل يعلّم أدوات الذكاء الاصطناعي — تقريبًا محد يعلّم التفكير مع الذكاء الاصطناعي. حللت ٤١٩ منشور"

  - name: "Vibe Coding and the Production Gap"
    type: article
    url: "https://jneaimi.com/en/insights/vibe-coding-production-gap"
    date: 2026-03-13
    topics: [vibe coding, production gap, prototype vs production, AI coding, code quality, security, scalability]
    cta_en: "Vibe coding ships prototypes fast — 167 posts reveal why the gap to production is cognitive, not technical"
    cta_ar: "الـ vibe coding ينتج نماذج أولية بسرعة — ١٦٧ منشور يكشفون ليش الفجوة للإنتاج ذهنية مو تقنية"

  - name: "The AI Developer Tools Landscape"
    type: article
    url: "https://jneaimi.com/en/insights/ai-developer-tools"
    date: 2026-03-12
    topics: [AI developer tools, Claude Code, Cursor, Copilot, context management, terminal development, solo founders, IDE wars]
    cta_en: "AI coding tools are converging — persistent context, not bigger models, is the real competitive edge"
    cta_ar: "أدوات البرمجة بالذكاء الاصطناعي تتقارب — السياق المستمر هو الميزة الحقيقية، مو النماذج الأكبر"

  - name: "Top-Down Learning with Bloom's Taxonomy"
    type: article
    url: "https://jneaimi.com/en/insights/top-down-learning-blooms"
    date: 2026-03-11
    topics: [top-down learning, Bloom's Taxonomy, cognitive science, evaluation first, retention, learning strategy]
    cta_en: "Start learning at Level 5 instead of Level 1 — the science behind why evaluation-first works"
    cta_ar: "ابدأ التعلّم من المستوى الخامس بدل الأول — العلم وراء لماذا التقييم أولًا يعطي نتائج أفضل"

  - name: "Building a Second Brain with Claude Code"
    type: article
    url: "https://jneaimi.com/en/insights/second-brain-claude-code"
    date: 2026-03-10
    topics: [Second Brain, Claude Code, Obsidian, knowledge management, persistent memory, PARA method, context loss]
    cta_en: "Stop losing context between AI sessions — I built a Second Brain that gives Claude Code persistent memory"
    cta_ar: "توقف عن خسارة السياق بين جلسات الذكاء الاصطناعي — بنيت نظام ذاكرة دائمة لـ Claude Code"

# ════════════════════════════════════════
# INTERNAL TOOLS (not public, but referenceable)
# ════════════════════════════════════════

  - name: Signal Forge
    type: tool
    url: null
    topics: [market intelligence, trend detection, AI agents pipeline, automation, multi-agent, signal monitoring]
    cta_en: "I built an agent pipeline that finds these signals automatically — 5 AI agents running daily"
    cta_ar: "بنيت نظام وكلاء ذكاء اصطناعي يكتشف هذه الإشارات تلقائيًا — ٥ وكلاء يعملون يوميًا"

# ════════════════════════════════════════
# PAGES (lower priority, reference sparingly)
# ════════════════════════════════════════

  - name: Insights Hub
    type: page
    url: "https://jneaimi.com/en/insights"
    topics: [AI research, enterprise AI, frameworks, articles]
    cta_en: "More data-driven insights on AI collaboration at jneaimi.com/insights"
    cta_ar: "المزيد من الرؤى المبنية على البيانات عن التعاون مع الذكاء الاصطناعي في jneaimi.com/insights"

  - name: Profile
    type: page
    url: "https://jneaimi.com/en/profile"
    topics: [Emirates NBD, Etihad Airways, Abu Dhabi, IT leadership, service delivery]
    cta_en: null
    cta_ar: null
```

## How to Add a New Asset

Add a new entry under `assets:` with:
- `name` — display name
- `type` — tool, framework, article, guide, video, page
- `url` — link (null for internal-only tools)
- `date` — publish date (articles only)
- `topics` — keywords the agent matches against finding titles/descriptions
- `cta_en` — English call-to-action (one sentence, end with "link in first comment" for LinkedIn)
- `cta_ar` — Arabic call-to-action (rewrite, not translation)

## Matching Priority

When multiple assets match a finding, the agent picks by priority:
1. **Tools** — strongest CTA, interactive, highest conversion
2. **Framework** — flagship IP, builds authority
3. **Articles** — deepest content, best for "I wrote about this" references
4. **Pages** — lowest priority, generic reference

Within the same type, pick the asset with the most keyword overlaps.
