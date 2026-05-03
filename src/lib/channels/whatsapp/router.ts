/** Slice 1.5 — Smart router for free-form (non-slash) messages.
 *
 *  Two-pass design:
 *
 *    1. **Regex pre-filter** — handles the obvious cases for free.
 *       Word-boundary patterns so transcribed-voice padding ("uh, OK so
 *       save this idea") still hits. Captures ~70 % of typical messages
 *       before any LLM call. Returns `source: 'regex'` with confidence 1.0.
 *
 *    2. **Gemini Flash fallback** — runs only when the regex didn't match.
 *       Output schema is flat-enum on `route` + flat scalars on `confidence`
 *       and `reason` per the AI SDK v6 + Gemini structured-output rule
 *       (discriminated unions break controlled generation; nested unions
 *       silently truncate). Asymmetric confidence thresholds: writes need
 *       ≥0.8 (a wrong save pollutes the vault), reads ≥0.6, chat ≥0.5
 *       (the safe default — wrong chat is just a noisy reply).
 *
 *  When the LLM is unavailable, fails, or returns sub-threshold confidence,
 *  the router falls back to `vault-chat` — same behaviour as `dynamic: false`.
 *  Slash commands never reach this layer; the dispatcher only calls the
 *  router when `intent.command` is unset (i.e. message didn't start with `/`).
 *
 *  Decisions land in a small in-process ring buffer surfaced at
 *  `/api/channels/whatsapp/status` as `recentRouterDecisions[]` so we can
 *  watch the regex-vs-LLM split and tune patterns over time.  */

import { generateText, Output, NoOutputGeneratedError } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import type { ResolvedIntent, WhatsAppIntentMap } from './types.js';

const ROUTER_MODEL = 'gemini-2.5-flash';
const ROUTER_TIMEOUT_MS = 4500;
const DECISION_BUFFER_MAX = 20;
const SAFE_DEFAULT = 'vault-chat';

/** Per-route confidence floors. Below the floor → fall back to vault-chat
 *  (the safe default — chatting back at the user is the cheap mistake).
 *
 *  **Writes are slash-only.** The brain-save route is intentionally absent
 *  from this map (and from the LLM enum below). Auto-routing a free-form
 *  "save this idea" to brain-save would create vault notes the user
 *  didn't explicitly ask for — including media captures the user might
 *  just want to discuss. `/save` remains the explicit handle for any
 *  capture intent. Reads are router-eligible because a wrong /find or
 *  /recent costs nothing — wrong save costs a junk note. */
const THRESHOLDS: Record<string, number> = {
	'brain-find': 0.6,
	'brain-recent': 0.6,
	'vault-chat': 0.5,
};

export interface RouterDecision {
	/** Truncated message preview — keeps the buffer cheap to serialize and
	 *  avoids leaking long bodies into the status endpoint. */
	input: string;
	route: string;
	confidence: number;
	source: 'regex' | 'llm' | 'fallback';
	reason?: string;
	ts: number;
}

const decisions: RouterDecision[] = [];

function logDecision(d: RouterDecision): void {
	decisions.unshift(d);
	if (decisions.length > DECISION_BUFFER_MAX) decisions.length = DECISION_BUFFER_MAX;
}

export function getRouterDecisions(): RouterDecision[] {
	return [...decisions];
}

/** Regex pre-filter. Returns the matched route name + a short reason
 *  string, or `null` if nothing matched. Patterns are intentionally
 *  conservative — false positives on a read are cheap, but writes are
 *  routed via slash only so the regex set covers reads only.
 *
 *  Save/capture verbs are deliberately absent here — see THRESHOLDS
 *  comment for rationale. */
function regexPreFilter(message: string): { route: string; reason: string } | null {
	const lower = message.toLowerCase();

	// Recency markers — "what did I", "what's recent/latest/new", "show me
	// recent". Tight enough that a vague "what's new with you" still misses.
	if (
		/\b(recent|latest)\s+(notes?|drafts?|captures?|saves?|writeups?|entries?)\b/.test(lower) ||
		/\b(what(?:\s+have\s+i|\s+did\s+i|'ve\s+i|\s+did\s+we|\s+have\s+we))\b/.test(lower) ||
		/\b(show\s+me\s+(?:my\s+)?(?:recent|latest|last))\b/.test(lower) ||
		/\bwhat'?s\s+new\b/.test(lower)
	) {
		return { route: 'brain-recent', reason: 'recency marker' };
	}

	// Find / search markers — explicit search verbs.
	if (
		/\b(find|search|look\s+up|lookup|grep|locate)\b/.test(lower) ||
		/\b(do\s+i\s+have|have\s+i\s+saved|did\s+i\s+(?:save|write|note))\b/.test(lower) ||
		/\bwhere(?:'s|\s+is|\s+was)\s+(?:my|the|that)\s+\w+/.test(lower)
	) {
		return { route: 'brain-find', reason: 'search marker' };
	}

	return null;
}

/** Output schema for the LLM router. Flat enum on `route`, flat scalars
 *  on the rest — Gemini's controlled generation rejects discriminated
 *  unions and quietly drops nested objects. */
const RouterDecisionSchema = z.object({
	route: z
		.enum(['brain-find', 'brain-recent', 'vault-chat'])
		.describe('Which intent best matches the user message. Default to "vault-chat" when unsure — chatting back is the safe mistake. Saving to the vault is slash-only (`/save`); never route here.'),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe('Your confidence in the route, 0 to 1. Use ≥0.6 for clear retrieval intent; below 0.5 routes to vault-chat anyway.'),
	reason: z
		.string()
		.describe('Short (≤ 12 words) explanation of why this route fits.')
		.optional(),
});

const ROUTER_SYSTEM_PROMPT = `You route inbound WhatsApp messages to one of three read intents on a Soul Hub vault assistant. Saving to the vault is slash-only (\`/save\`) and never reachable from this router — if the user wants to capture something, they will use the explicit slash command, so route capture-sounding messages to vault-chat for discussion instead.

Routes:
- brain-find: user wants to retrieve a specific past note. Search verbs: find, search, look up, "where's my note about ...", "do I have anything on ...".
- brain-recent: user wants the most-recently-touched notes. Recency markers: "what's new", "show me recent decisions", "what did I work on yesterday".
- vault-chat: free-form questions, discussion, or anything that doesn't clearly want a list of past notes. This is the safe default. Use it for "save this idea …", "remember to …", "look at this image and tell me what you think" — saving is opt-in via /save, so phrasing like that is for discussion, not capture.

Confidence calibration:
- 0.9–1.0: unambiguous explicit retrieval intent ("find my notes about heartbeat").
- 0.7–0.8: clear intent with light noise ("hey, show me what I wrote about chess engines").
- 0.5–0.6: ambiguous — pick the most plausible read route but flag it.
- below 0.5: route to vault-chat.

When in doubt, vault-chat. Discussion is always the right default.`;

async function llmRoute(
	message: string,
): Promise<{ route: string; confidence: number; reason?: string } | null> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) return null;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ROUTER_TIMEOUT_MS);

	try {
		const client = createGoogleGenerativeAI({ apiKey });
		const result = await generateText({
			model: client(ROUTER_MODEL),
			output: Output.object({ schema: RouterDecisionSchema }),
			system: ROUTER_SYSTEM_PROMPT,
			messages: [{ role: 'user', content: message }],
			maxOutputTokens: 200,
			abortSignal: ctrl.signal,
			providerOptions: {
				google: {
					thinkingConfig: { thinkingBudget: 0 },
				},
			},
		});
		clearTimeout(timer);
		return {
			route: result.output.route,
			confidence: result.output.confidence,
			reason: result.output.reason,
		};
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof NoOutputGeneratedError) return null;
		// Any other failure (timeout, network, schema mismatch) — degrade
		// silently to the safe default. We log it via the decision buffer
		// downstream so the user can see the failure pattern.
		return null;
	}
}

/** Public entry — routes a free-form (non-slash) message. Always returns
 *  a route name; logs the decision to the in-process ring buffer.
 *
 *  Order: regex (free) → LLM (~150ms + ~$0.0001) → safe-default fallback.
 *  Confidence below the per-route threshold also collapses to vault-chat. */
export async function routeFreeForm(message: string): Promise<RouterDecision> {
	const ts = Date.now();
	const inputPreview = message.length > 80 ? message.slice(0, 77) + '…' : message;

	const regexHit = regexPreFilter(message);
	if (regexHit) {
		const decision: RouterDecision = {
			input: inputPreview,
			route: regexHit.route,
			confidence: 1,
			source: 'regex',
			reason: regexHit.reason,
			ts,
		};
		logDecision(decision);
		return decision;
	}

	const llmHit = await llmRoute(message);
	if (!llmHit) {
		const decision: RouterDecision = {
			input: inputPreview,
			route: SAFE_DEFAULT,
			confidence: 0,
			source: 'fallback',
			reason: 'llm unavailable / failed',
			ts,
		};
		logDecision(decision);
		return decision;
	}

	const floor = THRESHOLDS[llmHit.route] ?? 0.5;
	if (llmHit.confidence < floor) {
		const decision: RouterDecision = {
			input: inputPreview,
			route: SAFE_DEFAULT,
			confidence: llmHit.confidence,
			source: 'fallback',
			reason: `${llmHit.route} below threshold (${llmHit.confidence.toFixed(2)} < ${floor})`,
			ts,
		};
		logDecision(decision);
		return decision;
	}

	const decision: RouterDecision = {
		input: inputPreview,
		route: llmHit.route,
		confidence: llmHit.confidence,
		source: 'llm',
		reason: llmHit.reason,
		ts,
	};
	logDecision(decision);
	return decision;
}

/** Helper used by both dispatch paths (in-process + worker `_inbound`).
 *  Returns the (possibly rewritten) intent. Slash commands and empty
 *  bodies bypass — the router has nothing to chew on. The `dynamic` flag
 *  on `intentMap.default` is the master switch; when off, free-form
 *  messages keep flowing to vault-chat as before. */
export async function maybeApplyRouter(
	intent: ResolvedIntent,
	intentMap: WhatsAppIntentMap,
): Promise<ResolvedIntent> {
	if (intent.command) return intent; // explicit slash — never overridden
	if (!intentMap.default?.dynamic) return intent; // feature off
	const trimmed = intent.body.trim();
	if (!trimmed) return intent; // nothing to route on

	const decision = await routeFreeForm(trimmed);
	if (decision.route === intent.route) return intent;
	return { ...intent, route: decision.route };
}
