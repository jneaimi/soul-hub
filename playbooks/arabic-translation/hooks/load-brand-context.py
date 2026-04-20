#!/usr/bin/env python3
"""
Pre-run hook: load domain-aware Arabic writing context.
Produces a reference file the translator/editor/consolidator read to decide
tone, register, and anti-slop rules based on the confirmed domain.

Usage: python3 hooks/load-brand-context.py "<domain_hint>"
Output: JSON to stdout + hooks/output/brand-context.md
"""
import sys
import json
from pathlib import Path

HOOKS_OUTPUT = Path(__file__).parent / "output"
HOOKS_OUTPUT.mkdir(exist_ok=True)

domain_hint = (sys.argv[1] if len(sys.argv) > 1 else "auto").strip().lower()

BRAND_ON_DOMAINS = {"marketing", "social-media", "blog", "news"}
BRAND_OFF_DOMAINS = {"legal", "medical", "technical", "academic", "financial"}

context = """# Arabic Translation — Domain-Aware Writing Context

All output must be **Modern Standard Arabic (فصحى / MSA)**. Never use dialect
(Khaleeji, Egyptian, Levantine, Maghrebi). MSA reads naturally to educated
Arabic speakers across the Arab world.

Decide which tone section to apply based on the **confirmed domain** from
the `confirm-domain` phase. Apply the anti-slop rules to ALL translations
regardless of domain.

---

## Section 1 — Brand Voice (apply when domain is: marketing, social-media, blog, news)

Persona: **Warm + Professional + Visionary** — the `/arabic` skill brand voice
(GCC audience: UAE, Saudi, Qatar, Kuwait, Bahrain, Oman).

- Tone: confident, inviting, forward-looking. Not stiff; not salesy.
- Register: educated MSA that a UAE reader perceives as natural (not Levantine-
  flavoured MSA from media, not archaic Quranic MSA).
- Address the reader directly where appropriate (أنت / عزيزي القارئ).
- Prefer transcreation over literal translation — reshape idioms and cultural
  references so they land for a GCC reader.
- Sentence length: short to medium. Vary rhythm.
- Avoid Anglicisms and English loanwords when a clean Arabic equivalent exists.
  Keep established technical terms in English with Arabic gloss on first use
  (e.g., "واجهة برمجة التطبيقات (API)").

---

## Section 2 — Domain Conventions (apply when domain is: legal, medical, technical, academic, financial)

No brand overlay. Fidelity and precision dominate tone.

- **Legal:** high-register formal MSA. Use established legal terminology
  (الطرف الأول / الطرف الثاني، يُقرّ، يتعهد، حيثما ورد). Preserve clause
  numbering and structure exactly. Never soften obligations. Flag any term
  that has jurisdiction-specific meaning.
- **Medical:** precise clinical MSA. Use WHO/AAOIFI-style standardised
  terminology. Keep drug names, dosages, and units in English with Arabic
  gloss. Never paraphrase dosing or contraindication language.
- **Technical:** precise MSA with established technical terms. Keep code,
  commands, error strings, filenames in English. Translate surrounding
  explanation only. Prefer "الدالة" over "الفنكشن".
- **Academic:** formal MSA with scholarly register. Preserve citations and
  reference formatting exactly. Use the passive voice where the source does.
- **Financial:** precise MSA with standardised financial/accounting terms
  (الأصول، الخصوم، التدفقات النقدية). Keep numbers, currencies, and ticker
  symbols exactly. Never round or paraphrase figures.

---

## Section 3 — Universal Arabic Anti-Slop (MANDATORY for all domains)

Avoid these AI-translation tells. They signal machine output in Arabic:

- Overuse of "بشكل كبير" / "بشكل ملحوظ" / "بشكل عام" as filler
- "من الجدير بالذكر أن" (stalling phrase — get to the point)
- "في عالم اليوم" / "في عصرنا الحالي" (AI opener cliché)
- "لا شك أن" / "من الواضح أن" as padding (only use when genuinely emphasising)
- Literal translation of English idioms ("يضرب عصفورين بحجر واحد" — use the
  Arabic equivalent or rewrite the idea)
- Redundant pairs: "سريع وفعّال"، "شامل وكامل"، "مهم وضروري" (pick one)
- "تجدر الإشارة إلى أن" at paragraph starts (AI tic)
- Overly long nominal chains — break into shorter verbal sentences
- Translating English passive voice when Arabic active reads better
- "يلعب دورًا مهمًا في" (cliché — say what role, concretely)
- Starting consecutive sentences with "و" when English had "And"
- Keeping English sentence structure (subject-verb-object rigidity) when
  Arabic verbal sentence (verb-subject-object) reads more natural

**Write like an Arabic-native subject-matter expert, not a translation engine.**

---

## Section 4 — Formatting & Diacritics

- Punctuation: Arabic comma "،" not Latin ","; Arabic question mark "؟"
- Numbers: keep Western Arabic numerals (1, 2, 3) — match the source's
  convention unless the user specifies Eastern Arabic (١، ٢، ٣)
- Diacritics (tashkeel): use sparingly — only where ambiguity exists or
  pronunciation matters (names, technical terms, poetry)
- Quotes: use "..." (same as Latin) or Arabic quotation marks «...» for
  formal/academic work
- Preserve Markdown structure from the source (headings, lists, code blocks,
  links). Do not translate code or URLs.
"""

context_path = HOOKS_OUTPUT / "brand-context.md"
context_path.write_text(context)

if domain_hint in BRAND_ON_DOMAINS:
    suggested_section = "Section 1 (brand voice)"
elif domain_hint in BRAND_OFF_DOMAINS:
    suggested_section = "Section 2 (domain conventions)"
else:
    suggested_section = "decide after confirm-domain phase"

output = {
    "status": "completed",
    "domain_hint": domain_hint,
    "suggested_section": suggested_section,
    "context_path": str(context_path),
}

print(json.dumps(output))
