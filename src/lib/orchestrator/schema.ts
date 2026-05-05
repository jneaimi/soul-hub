/**
 * Runtime-built Zod schema for the orchestrator decision.
 *
 * The `agent` enum is rebuilt per call from `listAgents()` filtered on
 * `health === 'ready'`, so newly created agents become dispatchable
 * immediately and unhealthy ones drop out — without a build step.
 *
 * No discriminated unions: per `feedback_ai_sdk_v6_structured_output`,
 * Gemini's controlled generation rejects them. Flat object, optional
 * fields, validation rules enforced in `decide.ts` rather than at the
 * schema layer.
 */

import { z } from 'zod';
import { listAgents } from '$lib/agents/store.js';
import type { AgentSummary } from '$lib/agents/types.js';

export interface OrchestratorSchemaContext {
	schema: z.ZodSchema;
	agents: AgentSummary[];
}

/** Build the schema + return the agent list used to construct it. The
 *  caller wants both — the agent list feeds the system prompt's inventory
 *  and the post-validation policy gate. */
export function buildOrchestratorSchema(): OrchestratorSchemaContext {
	const ready = listAgents().agents.filter((a) => a.health === 'ready');

	const agentEnum =
		ready.length === 0
			? z.string()
			: z.enum([ready[0].id, ...ready.slice(1).map((a) => a.id)] as [string, ...string[]]);

	const schema = z.object({
		action: z.enum(['reply', 'dispatch', 'clarify']),
		reply: z.string().optional(),
		agent: agentEnum.optional(),
		task: z.string().min(20).max(2000).optional(),
		confidence: z.number().min(0).max(1),
		// Reasoning is audit-only (logs); Gemini sometimes packs verbose
		// chain-of-thought in here, so don't reject the whole payload over
		// length. Truncated downstream when written to logs.
		reasoning: z.string().optional(),
	});

	return { schema, agents: ready };
}
