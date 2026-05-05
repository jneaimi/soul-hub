/**
 * Public dispatch API.
 *
 * `dispatchAgent(id, task, opts)` — backend-agnostic façade. Loads the agent
 * record, picks the right dispatcher, applies the resolved budget, streams
 * `DispatchEvent`s, and returns a final `DispatchResult`. Persists one row
 * per terminal status to `agent_runs` (queries in `src/lib/agents/runs.ts`).
 *
 * Other modules (orchestrator, scheduler, pipeline blocks, WhatsApp router)
 * consume this — they don't know or care which lane the agent uses.
 */

import type { AgentSummary } from '../types.js';
import { getAgent } from '../store.js';
import type {
	BackendDispatcher,
	DispatchEvent,
	DispatchMode,
	DispatchResult,
} from './types.js';
import { claudePtyDispatcher } from './claude-pty.js';
import { claudeCliFlagDispatcher } from './claude-cli-flag.js';
import { aiSdkDispatcher } from './ai-sdk.js';
import { recordAgentRun } from '../runs.js';

const dispatchers: Record<AgentSummary['backend'], BackendDispatcher> = {
	'claude-pty': claudePtyDispatcher,
	'claude-cli-flag': claudeCliFlagDispatcher,
	'ai-sdk': aiSdkDispatcher,
};

export interface DispatchAgentOptions {
	mode?: DispatchMode;
	signal?: AbortSignal;
	/** WhatsApp orchestrator (ADR-005) populates these — UI/API dispatches leave undefined. */
	jid?: string;
	sourceMessage?: string;
	/** Phase 5 — orchestrator-built conversation brief inlined into the agent's
	 *  task prompt so dispatched agents see the prior topic + recent agent
	 *  output gist. Bounded ~600 chars upstream by `buildAgentContextBrief`. */
	context?: string;
}

/** Run an agent. Streams events; the generator's return value is the final
 *  `DispatchResult`. Use `for await ... of` and the iterator-protocol return
 *  to capture both the stream and the summary in a single pass. */
export async function* dispatchAgent(
	id: string,
	task: string,
	opts: DispatchAgentOptions = {},
): AsyncGenerator<DispatchEvent, DispatchResult, void> {
	const mode: DispatchMode = opts.mode ?? 'production';
	const startedAt = Date.now();

	const agent = getAgent(id);
	if (!agent) {
		const err = `agent '${id}' not found`;
		yield { type: 'error', message: err, ts: Date.now() };
		const noAgentResult: DispatchResult = {
			runId: 'no-agent',
			agentId: id,
			backend: 'claude-pty',
			status: 'error',
			output: '',
			cost_usd: 0,
			num_turns: 0,
			duration_ms: 0,
			error: err,
		};
		// Skip persistence — no agent record to attribute the run to. The
		// caller will see status='error' in the streamed event.
		return noAgentResult;
	}

	const dispatcher = dispatchers[agent.backend];
	if (!dispatcher) {
		const err = `no dispatcher for backend '${agent.backend}'`;
		yield { type: 'error', message: err, ts: Date.now() };
		const noDispatcherResult: DispatchResult = {
			runId: 'no-dispatcher',
			agentId: id,
			backend: agent.backend,
			status: 'error',
			output: '',
			cost_usd: 0,
			num_turns: 0,
			duration_ms: 0,
			error: err,
		};
		persistRun(noDispatcherResult, agent, mode, task, startedAt, opts);
		return noDispatcherResult;
	}

	const result = yield* dispatcher.dispatch(agent, {
		mode,
		task,
		signal: opts.signal,
		context: opts.context,
	});

	persistRun(result, agent, mode, task, startedAt, opts);
	return result;
}

function persistRun(
	result: DispatchResult,
	agent: AgentSummary,
	mode: DispatchMode,
	task: string,
	startedAt: number,
	opts: DispatchAgentOptions,
): void {
	try {
		const finishedAt = Date.now();
		recordAgentRun({
			runId: result.runId,
			agentId: agent.id,
			backend: agent.backend,
			model: agent.model,
			provider: agent.provider,
			mode,
			taskSpec: task,
			sourceMessage: opts.sourceMessage,
			jid: opts.jid,
			startedAt,
			finishedAt,
			durationMs: result.duration_ms || finishedAt - startedAt,
			status: result.status,
			costUsd: result.cost_usd,
			numTurns: result.num_turns,
			resultExcerpt: result.output,
			errorMessage: result.error,
		});
	} catch (err) {
		// Persistence is best-effort — never fail a dispatch because the
		// audit log couldn't write. Surface the error in process logs so
		// it gets noticed.
		console.error('[agents/runs] failed to persist run:', (err as Error).message);
	}
}

export type { DispatchEvent, DispatchResult } from './types.js';
