/**
 * Orchestrator classifier — single Gemini Flash call with AI SDK
 * structured output (Output.object), bypassing the routes layer.
 *
 * Why direct (not dispatchRoute): Gemini Flash empirically refuses some
 * safety-sensitive prompts (image generation, real-time data) by emitting
 * a prose refusal even when instructed to output JSON only. AI SDK's
 * `Output.object({schema})` constrains the response at the API level
 * (Google's controlled-generation), so prose refusals are no longer
 * possible — the model MUST return schema-conforming JSON. This is the
 * same pattern the vault-chat selector uses (see `vault-chat/selector.ts`).
 *
 * The trade-off is no automatic OpenRouter failover — we lose the routes
 * layer. Acceptable here because the orchestrator is a fast,
 * cheap, non-essential lookup; on Gemini failure we fall through to
 * vault-chat just like before.
 *
 * Falls through (`fellThrough: true`) on any failure (no key, network
 * error, NoOutputGeneratedError, schema validation) — the caller drops
 * back to vault-chat. Never throws to the inbound handler.
 *
 * 2026-05-06: rewritten for the 7-action model (added generate-image).
 * Per-action validation:
 *   - `dispatch` requires confidence ≥0.85; below that → downgrade to
 *     `propose-dispatch` (review-before-execute, per ADR-006).
 *   - `propose-dispatch` requires agent + task + proposalLabel.
 *   - `web-search` requires webQuery (defaults to userMessage).
 *   - `generate-image` requires imagePrompt (defaults to userMessage).
 *   - `clarify` is the last-resort fallback.
 */

import { generateText, Output, NoOutputGeneratedError } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { buildOrchestratorSchema } from './schema.js';
import { buildSystemPrompt } from './prompt.js';
import type { DecideResult, OrchestratorDecision } from './types.js';
import type { ChatMessage } from '$lib/llm/types.js';

const MODEL = 'gemini-2.5-flash';
/** Direct dispatch requires high confidence. Below this → downgrade to
 *  propose-dispatch so the user sees the proposal and can confirm. */
const DISPATCH_CONFIDENCE_THRESHOLD = 0.85;
/** Floor for any decision — below this we treat the classifier as having
 *  given up and ask the user to rephrase. */
const CONFIDENCE_FLOOR = 0.4;
const ABSTAIN_REPLY = "I'm not sure what you want me to do — can you rephrase?";
/** Cap on the structured-output JSON itself. The schema is small (~12
 *  fields, mostly optional strings); 800 is plenty even with a long
 *  task description. Gemini Flash with thinkingBudget=0 won't pad. */
const MAX_OUTPUT_TOKENS = 800;
/** Keep the LLM call short — the inbound handler has its own timeout, but
 *  if Gemini hangs we'd rather fall through to vault-chat than block. */
const TIMEOUT_MS = 8_000;

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

	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: 'GEMINI_API_KEY not set',
		};
	}

	const system = buildSystemPrompt(agents);
	const history = opts.history ?? [];
	const messages: ChatMessage[] = [...history, { role: 'user', content: userMessage }];

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	const userSignal = opts.signal;
	const onUserAbort = () => ctrl.abort();
	if (userSignal) userSignal.addEventListener('abort', onUserAbort, { once: true });

	let parsed: unknown;
	try {
		const client = createGoogleGenerativeAI({ apiKey });
		const result = await generateText({
			model: client(MODEL),
			// `output: Output.object({schema})` binds Gemini's controlled-
			// generation feature so the response MUST conform to the schema.
			// No more prose refusals slipping through.
			output: Output.object({ schema }),
			system,
			messages,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			abortSignal: ctrl.signal,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
		});
		parsed = result.output;
	} catch (err) {
		clearTimeout(timer);
		if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
		if (err instanceof NoOutputGeneratedError) {
			return {
				decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
				fellThrough: true,
				note: 'NoOutputGeneratedError — Gemini produced no schema-conforming output',
			};
		}
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: `generateText failed: ${(err as Error).message}`,
		};
	} finally {
		clearTimeout(timer);
		if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
	}

	// Defensive: AI SDK already validated against the schema, but a stale
	// schema cache between requests could in theory let through fields the
	// new schema rejects. Cheap to re-validate.
	const validated = schema.safeParse(parsed);
	if (!validated.success) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: `Zod validation failed: ${validated.error.message}`,
		};
	}

	const decision = validated.data as unknown as OrchestratorDecision;

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
			// Fall back to using the user's raw message as the query.
			decision.webQuery = userMessage;
		}
	}

	if (decision.action === 'generate-image') {
		if (!decision.imagePrompt) {
			// Fall back to the raw message — `dispatchImg` will still produce
			// something usable; better than asking the user to retry.
			decision.imagePrompt = userMessage;
		}
		// Defensive: clear any stale agent/task that might have leaked through.
		decision.agent = undefined;
		decision.task = undefined;
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
