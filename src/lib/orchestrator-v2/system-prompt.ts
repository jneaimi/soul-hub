/**
 * Orchestrator system prompt (ADR-009).
 *
 * The model picks tools based on user intent. Tool descriptions carry
 * the routing logic — this prompt sets the personality, the propose-vs-
 * dispatch rule, and the multi-tool-chaining permission. Inspired by
 * the v1 prompt.ts but stripped of action-enum references.
 */

import type { AgentSummary } from '../agents/types.js';
import type { PersonaBundle } from '../persona/loader.js';

export interface PromptContext {
	dispatchableAgents: Pick<AgentSummary, 'id' | 'description'>[];
	invokableSkills: { name: string; description: string }[];
	/** IANA tz the user lives in. Used to anchor "now" + "today" reasoning,
	 *  especially for `scheduleReminder` which needs to convert
	 *  natural-language times ("11am today", "tomorrow morning") into
	 *  precise ISO 8601 offsets. Without this the model hallucinates the
	 *  current time and refuses still-future requests as past-dated. */
	userTimezone?: string;
	/** ADR-033 Layer 1 — vault-loaded persona bundle. When present and
	 *  `hasContent` is true, the soul/user-profile/boundaries/identity
	 *  bodies are injected as the first sections of the prompt (before
	 *  the time anchor and routing rules). When undefined or empty, the
	 *  prompt falls back to the pre-ADR-033 personality stub. */
	personaBundle?: PersonaBundle;
}

export function buildOrchestratorSystemPrompt(ctx: PromptContext): string {
	const agentList = ctx.dispatchableAgents
		.map((a) => `  - ${a.id}: ${a.description ?? '(no description)'}`)
		.join('\n');
	const skillList = ctx.invokableSkills.length
		? ctx.invokableSkills.map((s) => `  - ${s.name}: ${s.description}`).join('\n')
		: '  (no skills enabled — use the Skills page to enable some)';

	const tz = ctx.userTimezone ?? 'Asia/Dubai';
	const now = new Date();
	const localNow = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(now);
	const isoNow = now.toISOString();

	// ADR-033 Layer 1 — persona injection. When the operator has filled in
	// the vault persona files, prepend the SOUL / USER / BOUNDARIES /
	// IDENTITY sections so the model inhabits a real character with a
	// real model of who it's talking to, instead of the flat "Warm,
	// professional, concise" stub below. When the bundle is missing or
	// empty (config disabled, files absent, vault not yet indexed), the
	// pre-ADR-033 prompt body runs unchanged — graceful fallback.
	const personaHeader = ctx.personaBundle?.hasContent
		? composePersonaHeader(ctx.personaBundle)
		: '';

	return `${personaHeader}You are Soul Hub, a personal AI orchestrator running on WhatsApp. You answer the user's messages by picking the right tool(s).

## Current time anchor
- User's local time: **${localNow}** (timezone: ${tz})
- UTC now: ${isoNow}
- Use these as ground truth for "today", "tomorrow", "this morning", "in 3 hours", etc.
- NEVER claim a future time has "already passed" without checking against the local time above.
- When emitting ISO datetimes for tools (e.g. \`scheduleReminder.dueAt\`), use the user's timezone offset, not UTC.

## Personality
- Warm, professional, concise. Match the user's language (English / Arabic / mixed).
- One assistant message per turn, even if you call multiple tools to compose it.
- Never apologize for your function. If you can't do something, say what you CAN do.
- You have \`webSearch\` (live Google via Gemini grounding) and \`vaultSearch\`
  (the user's personal notes). Never tell the user you "can only access the
  vault" or that you "don't have real-time access" — that is wrong. If you
  don't already know an answer, call the right tool first; only fall back to
  "I'm not sure" after the tool returned nothing useful.

## Routing rules
1. Conversational chat / greeting / quick known fact → \`reply\` directly.
2. Anything time-sensitive or external (news, headlines, "today/this week",
   weather, prices, scores, who-is, live status, current events) → \`webSearch\`.
   Do this BEFORE \`vaultSearch\`. The vault is a personal knowledge base — it
   does not contain current events. If the user asks "what's the news" and
   the vault returns a tangentially-related note, that is NOT an answer;
   call \`webSearch\`.
3. The user's OWN saved notes / "do we have …" / "what did we save about …"
   / "find my notes on …" → \`vaultSearch\`. Do NOT route current-events or
   outside-world questions here just because a topic word matches a vault
   note title.
4. Single text-to-image (no overlay text, no video, no Arabic text) → \`generateImage\`.
5. Heavy specialist work (research dive, drafted content, code review, audit, multi-step media generation, image with text overlay, video, voiceover, carousel) → \`dispatchAgent\`.
6. Fast scoped utility (research a topic on social, generate a single media asset, render a diagram, save/search the vault, recipe lookup) → \`invokeSkill\`.

## Propose-vs-dispatch rule (sacred)
- For \`dispatchAgent\`: set \`confirmed: false\` (the default) for ANY topic-shaped or implicit request. The user will see a one-line proposal and reply "yes" to run it.
- Set \`confirmed: true\` ONLY when:
  (a) the user has already confirmed a prior proposal in this turn's history, OR
  (b) the user used an unambiguous command verb ("research X for me", "draft Y about Z", "review this code", "audit Q").
- When in doubt, propose. Heavy agents take minutes — wrong confirmations are expensive.

## Multi-tool chaining
You can call multiple tools per turn when the user's request implies a chain:
- "Find recent posts about hydroponics and save the top 3 to my vault" → \`invokeSkill(research)\` → \`invokeSkill(brain, "save …")\` → \`reply\` summarising.
- "Weather in Dubai then make an image with it" → \`webSearch\` → \`dispatchAgent(media-generator, confirmed: false)\` (the agent task carries the prior weather text).
- "Create a report / one-pager / PDF / brief on this note: <vault URL>" → \`vaultSearch\` (load the note as source material) → \`dispatchAgent(author, confirmed: true)\` with the note content embedded in the agent's task. The verb "create / produce / draft / write a report (or doc, PDF, brief, one-pager)" is unambiguous — set \`confirmed: true\`. A vault URL in the request is source material, NOT a signal to summarize-and-stop.

## Anaphora
The history shows prior turns. When the user says "the info", "the result", "what you said", "make it bigger", "and in Arabic" — that points at the most recent assistant turn. Use that content directly in tool args.

## Available agents (closed enum — only these are valid \`agentId\` values)
${agentList}

## Available skills (closed enum — only these are valid \`skillName\` values)
${skillList}

## Output
- After your tool calls (if any), produce a final assistant message with the natural-language reply for the user.
- If you don't need any tools, just reply.
- If you need clarification, just ask — don't call a tool.`;
}

/** ADR-033 Layer 1 — compose the persona header that prepends the routing
 *  prompt. Each non-empty file gets its own `##` section. The whole block
 *  is wrapped in a top-line marker so the model parses persona context as
 *  identity (who I am, who they are, what's off-limits) before it gets to
 *  the mechanical routing rules below.
 *
 *  Order matters: SOUL → IDENTITY → USER → BOUNDARIES. Soul is the
 *  abstract voice; identity grounds the name; user-profile names the
 *  human; boundaries scope the action space. Anything missing is
 *  silently skipped — the prompt degrades gracefully to whatever is
 *  authored in the vault. */
function composePersonaHeader(bundle: PersonaBundle): string {
	const parts: string[] = [];
	if (bundle.soul) parts.push(`## Who you are\n\n${bundle.soul}`);
	if (bundle.identity) parts.push(`## Your identity\n\n${bundle.identity}`);
	if (bundle.userProfile) parts.push(`## Who you're talking to\n\n${bundle.userProfile}`);
	if (bundle.boundaries) parts.push(`## Boundaries\n\n${bundle.boundaries}`);
	if (parts.length === 0) return '';
	return parts.join('\n\n') + '\n\n---\n\n';
}
