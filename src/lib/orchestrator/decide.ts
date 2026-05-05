/**
 * Orchestrator classifier — single Gemini Flash call via the routes layer.
 *
 * Flow:
 *   1. Build the schema (agent enum from `listAgents()`).
 *   2. Build the system prompt with agent inventory.
 *   3. `dispatchRoute('orchestrator', …)` — gets failover for free.
 *   4. Strip optional code fences, JSON.parse, Zod-validate.
 *   5. Apply confidence gates + the shell-policy gate.
 *
 * Falls through (`fellThrough: true`) on any failure — the caller drops
 * back to vault-chat. Never throws to the inbound handler.
 */

import { dispatchRoute } from '$lib/routes/index.js';
import { buildOrchestratorSchema } from './schema.js';
import { buildSystemPrompt } from './prompt.js';
import type { DecideResult, OrchestratorDecision } from './types.js';
import type { AgentSummary } from '$lib/agents/types.js';

const ORCHESTRATOR_ROUTE = 'orchestrator';
const CONFIDENCE_DISPATCH_THRESHOLD = 0.7;
const CONFIDENCE_FLOOR = 0.5;
const ABSTAIN_REPLY = "I'm not sure what you want me to do — can you rephrase?";

/** Strip ``` fences and any leading/trailing prose Gemini sometimes adds
 *  even when told not to. Returns the first balanced `{...}` block found. */
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
	/** Disallow agents whose `tools` include `Bash` from dispatching via
	 *  chat. Defaults to true (the WhatsApp inbound handler should never
	 *  flip this off). */
	denyShellAgents?: boolean;
}

export async function decide(userMessage: string, opts: DecideOptions = {}): Promise<DecideResult> {
	const { schema, agents } = buildOrchestratorSchema();

	if (agents.length === 0) {
		return {
			decision: { action: 'clarify', reply: ABSTAIN_REPLY, confidence: 0 },
			fellThrough: true,
			note: 'no ready agents in registry',
		};
	}

	const system = buildSystemPrompt(agents);
	let rawText = '';
	try {
		const result = await dispatchRoute(ORCHESTRATOR_ROUTE, {
			system,
			messages: [{ role: 'user', content: userMessage }],
			maxOutputTokens: 400,
			signal: opts.signal,
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

		if (decision.confidence < CONFIDENCE_DISPATCH_THRESHOLD) {
			return {
				decision: {
					action: 'clarify',
					reply: `I think you want me to use \`${decision.agent}\` for this — confirm or rephrase?`,
					confidence: decision.confidence,
				},
				fellThrough: false,
				note: `dispatch downgraded — confidence ${decision.confidence} below threshold`,
			};
		}

		const denyShell = opts.denyShellAgents !== false;
		if (denyShell && agentHasShell(agents, decision.agent)) {
			return {
				decision: {
					action: 'reply',
					reply: `\`${decision.agent}\` has shell access and isn't allowed to run from chat. Use the /agents UI to dispatch it.`,
					confidence: decision.confidence,
				},
				fellThrough: false,
				note: 'shell-policy refusal',
			};
		}
	}

	return { decision, fellThrough: false };
}

function agentHasShell(agents: AgentSummary[], id: string): boolean {
	const a = agents.find((x) => x.id === id);
	if (!a) return false;
	return a.tools.some((t) => t === 'Bash' || t.toLowerCase() === 'shell');
}
