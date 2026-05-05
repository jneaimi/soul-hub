/**
 * Orchestrator classifier — single Gemini Flash call via the routes layer.
 *
 * Flow:
 *   1. Build the schema (agent enum from `listAgents()`).
 *   2. Build the system prompt with agent inventory.
 *   3. `dispatchRoute('orchestrator', …)` — gets failover for free.
 *   4. Strip optional code fences, JSON.parse, Zod-validate.
 *   5. Apply confidence gates + cross-field validation.
 *
 * Falls through (`fellThrough: true`) on any failure — the caller drops
 * back to vault-chat. Never throws to the inbound handler.
 *
 * 2026-05-06: rewritten for the 6-action model. Key gates:
 *   - `dispatch` requires confidence ≥0.85; below that → downgrade to
 *     `propose-dispatch` (review-before-execute, per ADR-006).
 *   - `propose-dispatch` requires agent + task + proposalLabel.
 *   - `web-search` requires webQuery.
 *   - `clarify` is the last-resort fallback when anything else fails.
 */

import { dispatchRoute } from '$lib/routes/index.js';
import { buildOrchestratorSchema } from './schema.js';
import { buildSystemPrompt } from './prompt.js';
import type { DecideResult, OrchestratorDecision } from './types.js';
import type { ChatMessage } from '$lib/llm/types.js';

const ORCHESTRATOR_ROUTE = 'orchestrator';
/** Direct dispatch requires high confidence. Below this → downgrade to
 *  propose-dispatch so the user sees the proposal and can confirm. */
const DISPATCH_CONFIDENCE_THRESHOLD = 0.85;
/** Floor for any decision — below this we treat the classifier as having
 *  given up and ask the user to rephrase. */
const CONFIDENCE_FLOOR = 0.4;
const ABSTAIN_REPLY = "I'm not sure what you want me to do — can you rephrase?";

function extractJsonBlock(raw: string): string | null {
	const trimmed = raw.trim();
	const start = trimmed.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return trimmed.slice(start, i + 1);
		}
	}
	return null;
}

export interface DecideOptions {
	signal?: AbortSignal;
	history?: ChatMessage[];
}

export async function decide(userMessage: string, opts: DecideOptions = {}): Promise<DecideResult> {
	const { schema, agents } = buildOrchestratorSchema();

	if (agents.length === 0) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: 'no chat-dispatchable agents in registry',
		};
	}

	const system = buildSystemPrompt(agents);
	const history = opts.history ?? [];
	const messages: ChatMessage[] = [...history, { role: 'user', content: userMessage }];
	let rawText = '';
	try {
		const result = await dispatchRoute(ORCHESTRATOR_ROUTE, {
			system,
			messages,
			// 800 leaves headroom for the JSON payload after Gemini reserves
			// thinking tokens (even with thinkingBudget=0, Flash still emits
			// short reasoning preambles occasionally). 500 was empirically
			// too tight — orchestrator fell through to vault-chat with
			// "non-JSON output" on real WhatsApp messages 2026-05-06.
			maxOutputTokens: 800,
			signal: opts.signal,
			// Disable thinking on Gemini Flash for the classifier — we want
			// fast structured JSON, not extended reasoning. See feedback
			// `gemini_thinking_budget`. Ignored by the OpenRouter primary
			// (per-AI-SDK-spec), so safe across the whole failover chain.
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
		});
		rawText = result.text ?? '';
	} catch (err) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: `dispatchRoute failed: ${(err as Error).message}`,
		};
	}

	const jsonBlock = extractJsonBlock(rawText);
	if (!jsonBlock) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: 'orchestrator returned non-JSON output',
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonBlock);
	} catch (err) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: `JSON parse failed: ${(err as Error).message}`,
		};
	}

	const validated = schema.safeParse(parsed);
	if (!validated.success) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: `Zod validation failed: ${validated.error.message}`,
		};
	}

	const decision = validated.data as OrchestratorDecision;

	if (decision.confidence < CONFIDENCE_FLOOR) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: decision.confidence },
			fellThrough: false,
			note: `confidence ${decision.confidence} below floor ${CONFIDENCE_FLOOR}`,
		};
	}

	// Per-action cross-field validation. Each action has required fields;
	// missing fields are downgraded to clarify (or propose-dispatch) rather
	// than thrown — the runtime never wants to crash a user message.

	if (decision.action === 'reply') {
		if (!decision.reply) {
			return {
				decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: decision.confidence },
				fellThrough: false,
				note: 'reply action missing reply text',
			};
		}
	}

	if (decision.action === 'web-search') {
		if (!decision.webQuery) {
			// Fall back to using the user's raw message as the query — better
			// than failing.
			decision.webQuery = userMessage;
		}
	}

	if (decision.action === 'vault-search') {
		// No required fields. Defensive: clear any stale agent/task that
		// might have leaked through from the model.
		decision.agent = undefined;
		decision.task = undefined;
	}

	if (decision.action === 'propose-dispatch') {
		if (!decision.agent || !decision.task || !decision.proposalLabel) {
			return {
				decision: {
					action: 'clarify',
					reply: 'I want to propose something to delegate, but I need more detail — what specifically should I do?',
					confidence: decision.confidence,
				},
				fellThrough: false,
				note: 'propose-dispatch missing agent/task/proposalLabel',
			};
		}
	}

	if (decision.action === 'dispatch') {
		if (!decision.agent || !decision.task) {
			return {
				decision: {
					action: 'clarify',
					reply: 'I want to delegate that, but I need more detail — what specifically should I do?',
					confidence: decision.confidence,
				},
				fellThrough: false,
				note: 'dispatch missing agent or task',
			};
		}

		// Direct dispatch needs high confidence. Below the threshold, downgrade
		// to propose-dispatch so the user reviews before the heavy run fires.
		if (decision.confidence < DISPATCH_CONFIDENCE_THRESHOLD) {
			const label =
				decision.proposalLabel ??
				`${decision.agent}: ${decision.task.slice(0, 60)}${decision.task.length > 60 ? '…' : ''}`;
			return {
				decision: {
					action: 'propose-dispatch',
					agent: decision.agent,
					task: decision.task,
					proposalLabel: label,
					confidence: decision.confidence,
					reasoning: decision.reasoning,
				},
				fellThrough: false,
				note: `dispatch downgraded to propose — confidence ${decision.confidence} < ${DISPATCH_CONFIDENCE_THRESHOLD}`,
			};
		}
	}

	if (decision.action === 'clarify' && !decision.reply) {
		decision.reply = ABSTAIN_REPLY;
	}

	return { decision, fellThrough: false };
}
