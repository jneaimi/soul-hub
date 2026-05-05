/**
 * Dispatch types — shared across the three backend dispatchers.
 *
 *   `DispatchEvent` is the streaming wire-format the test endpoint emits.
 *   `DispatchResult` is the final summary returned when the run finishes.
 *
 * Each backend dispatcher implements `dispatch(...)` returning an async
 * iterable of events plus a final `DispatchResult`.
 */

import type { AgentSummary } from '../types.js';

export type DispatchMode = 'production' | 'test';

export interface DispatchOptions {
	mode: DispatchMode;
	task: string;
	signal?: AbortSignal;
	/** Optional conversation brief built by the orchestrator. Lane dispatchers
	 *  prepend it to the task prompt so the agent sees the gist of the chat
	 *  it was dispatched from. Bounded to ~600 chars upstream — never the
	 *  raw 16-turn history. Empty/undefined → behave as before (single-shot). */
	context?: string;
}

export type DispatchEvent =
	| { type: 'started'; backend: string; model?: string; runId: string; ts: number }
	| { type: 'output'; data: string; ts: number }
	| { type: 'tool_call'; name: string; ts: number }
	| { type: 'step'; n: number; finishReason?: string; ts: number }
	| { type: 'error'; message: string; ts: number }
	| { type: 'done'; result: DispatchResult; ts: number };

export interface DispatchResult {
	runId: string;
	agentId: string;
	backend: string;
	status: 'success' | 'error' | 'cancelled' | 'timeout' | 'budget-exceeded';
	output: string;
	cost_usd: number;
	num_turns: number;
	duration_ms: number;
	error?: string;
}

export interface BackendDispatcher {
	id: AgentSummary['backend'];
	dispatch(agent: AgentSummary, opts: DispatchOptions): AsyncGenerator<DispatchEvent, DispatchResult, void>;
}
