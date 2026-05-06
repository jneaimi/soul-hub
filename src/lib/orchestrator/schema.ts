/**
 * Runtime-built Zod schema for the orchestrator decision.
 *
 * The `agent` enum is rebuilt per call from `listAgents()` filtered on
 * `health === 'ready'` AND `chat_dispatchable === true`, so newly created
 * agents become dispatchable immediately without a build step.
 *
 * Per `feedback_ai_sdk_v6_structured_output` memory: Gemini's controlled
 * generation rejects discriminated unions. Flat object, optional fields,
 * cross-field validation enforced in `decide.ts`.
 */

import { z } from 'zod';
import { listAgents } from '$lib/agents/store.js';
import type { AgentSummary } from '$lib/agents/types.js';

export interface OrchestratorSchemaContext {
	/** A `z.ZodObject` (loosely-typed return so the union of agent enums
	 *  doesn't leak into every caller). `decide.ts` uses this with AI
	 *  SDK's `Output.object({schema})`. */
	schema: z.ZodObject<z.ZodRawShape>;
	agents: AgentSummary[];
}

export function buildOrchestratorSchema(): OrchestratorSchemaContext {
	const ready = listAgents().agents.filter(
		(a) => a.health === 'ready' && a.chat_dispatchable === true,
	);

	const agentEnum =
		ready.length === 0
			? z.string()
			: z.enum([ready[0].id, ...ready.slice(1).map((a) => a.id)] as [string, ...string[]]);

	const schema = z.object({
		action: z.enum([
			'reply',
			'web-search',
			'vault-search',
			'generate-image',
			'propose-dispatch',
			'dispatch',
			'clarify',
		]),
		reply: z.string().optional(),
		agent: agentEnum.optional(),
		task: z.string().min(20).max(2000).optional(),
		proposalLabel: z.string().max(120).optional(),
		webQuery: z.string().max(500).optional(),
		// `imagePrompt` for the generate-image action. Cap mirrors
		// `~/.soul-hub/data/whatsapp/<acct>/img.ts`'s 4000-char input cap;
		// 1500 here is plenty for natural-language requests.
		imagePrompt: z.string().max(1500).optional(),
		confidence: z.number().min(0).max(1),
		// Reasoning is audit-only (logs); Gemini sometimes packs verbose
		// chain-of-thought in here, so don't reject the whole payload over
		// length. Truncated downstream when written to logs.
		reasoning: z.string().optional(),
	});

	return { schema, agents: ready };
}
