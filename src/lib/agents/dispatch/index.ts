/**
 * Public dispatch API.
 *
 * `dispatchAgent(id, task, opts)` — backend-agnostic façade. Loads the agent
 * record, picks the right dispatcher, applies the resolved budget, and
 * returns an async iterable of `DispatchEvent`s plus a final
 * `DispatchResult`.
 *
 * Other modules (orchestrator, scheduler, pipeline blocks, WhatsApp router)
 * consume this — they don't know or care which lane the agent uses.
 *
 * v1 does not persist runs to a DB table; that lands with WhatsApp ADR-005.
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

const dispatchers: Record<AgentSummary['backend'], BackendDispatcher> = {
	'claude-pty': claudePtyDispatcher,
	'claude-cli-flag': claudeCliFlagDispatcher,
	'ai-sdk': aiSdkDispatcher,
};

export interface DispatchAgentOptions {
	mode?: DispatchMode;
	signal?: AbortSignal;
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

	const agent = getAgent(id);
	if (!agent) {
		const err = `agent '${id}' not found`;
		yield { type: 'error', message: err, ts: Date.now() };
		return {
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
	}

	const dispatcher = dispatchers[agent.backend];
	if (!dispatcher) {
		const err = `no dispatcher for backend '${agent.backend}'`;
		yield { type: 'error', message: err, ts: Date.now() };
		return {
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
	}

	return yield* dispatcher.dispatch(agent, {
		mode,
		task,
		signal: opts.signal,
	});
}

export type { DispatchEvent, DispatchResult } from './types.js';
