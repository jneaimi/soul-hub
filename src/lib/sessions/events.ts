/**
 * Soul Hub event vocabulary — emitted by pipeline / playbook / chain runners
 * into per-run JSONL files at ~/.soul-hub/runs/{runId}.jsonl.
 *
 * Mirrors Claude Code's JSONL pattern (one event per line, append-only) but
 * with a flat shape — no nested message blocks. The reader at summarize-soul-hub.ts
 * consumes this directly.
 *
 * Schema version starts at 1. Tolerate unknown event types in the reader.
 */

export type RunSurface = 'pipeline' | 'playbook' | 'chain' | 'subagent';
export type StepStatus = 'ok' | 'error' | 'skipped';
export type RunStatus = 'ok' | 'error' | 'killed';

export interface SoulHubEnvelope {
	version: 1;
	eventId: string;
	parentEventId?: string;
	timestamp: string;
	runId: string;
	parentRunId?: string;
}

export type SoulHubEventBody =
	| {
			type: 'run_start';
			surface: RunSurface;
			name: string;
			inputs?: Record<string, unknown>;
			cwd?: string;
			gitBranch?: string;
	  }
	| { type: 'step_start'; stepId: string; stepType: string; parentStepId?: string }
	| {
			type: 'step_end';
			stepId: string;
			status: StepStatus;
			durationMs: number;
			error?: string;
			outputPath?: string;
	  }
	| {
			type: 'agent_spawn';
			stepId: string;
			provider: string;
			model?: string;
			ptySessionId?: string;
			claudeSessionId?: string;
			childRunId?: string;
	  }
	| {
			type: 'tool_use';
			stepId?: string;
			toolUseId: string;
			tool: string;
			argsHash: string;
			argsPath?: string;
	  }
	| {
			type: 'tool_result';
			toolUseId: string;
			status: 'ok' | 'error';
			durationMs: number;
			bytesOut?: number;
			overflowPath?: string;
	  }
	| {
			type: 'output_landed';
			stepId: string;
			surface: 'vault' | 'project' | 'media' | 'patch';
			path: string;
			bytes: number;
	  }
	| {
			type: 'cost';
			stepId?: string;
			provider: string;
			model: string;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number;
			cacheCreate5mTokens?: number;
			cacheCreate1hTokens?: number;
			usd?: number;
	  }
	| { type: 'error'; stepId?: string; kind: string; message: string; stack?: string }
	| { type: 'run_end'; status: RunStatus; durationMs: number };

export type SoulHubEvent = SoulHubEnvelope & SoulHubEventBody;

export type SoulHubEventInput = Omit<SoulHubEvent, 'version' | 'eventId' | 'timestamp'> &
	Partial<Pick<SoulHubEvent, 'eventId' | 'timestamp'>>;

function randomEventId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Fill the common envelope on a partially-specified event. Callers pass the
 * body fields plus runId; envelope (version, eventId, timestamp) is generated.
 */
export function makeEnvelope(input: SoulHubEventInput): SoulHubEvent {
	return {
		version: 1,
		eventId: input.eventId ?? randomEventId(),
		timestamp: input.timestamp ?? new Date().toISOString(),
		...input,
	} as SoulHubEvent;
}

/**
 * Coerce an unknown line into a SoulHubEvent, validating only the bare
 * minimum (envelope shape + a known type). Returns null for unparseable
 * or unknown-type lines so the reader can skip without throwing.
 */
export function parseEventLine(line: string): SoulHubEvent | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') return null;
	const obj = raw as Record<string, unknown>;
	if (obj.version !== 1) return null;
	if (typeof obj.eventId !== 'string') return null;
	if (typeof obj.timestamp !== 'string') return null;
	if (typeof obj.runId !== 'string') return null;
	if (typeof obj.type !== 'string') return null;
	return obj as unknown as SoulHubEvent;
}
