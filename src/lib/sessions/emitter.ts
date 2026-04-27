/**
 * RunEventEmitter — append SoulHubEvent JSONL for a single run.
 *
 * Layout:
 *   ~/.soul-hub/runs/{runId}.jsonl                                — main event log
 *   ~/.soul-hub/runs/{runId}/subruns/run-{childRunId}.jsonl       — sub-run logs
 *   ~/.soul-hub/runs/{runId}/tool-results/hook-{toolUseId}-stdout.txt — overflow files
 *
 * Order is preserved by chaining each write through a single shared promise.
 * Callers can `await emit()` if they care about durability, or fire-and-forget.
 */

import { mkdirSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { makeEnvelope, type SoulHubEvent, type SoulHubEventInput } from './events.js';

const RUNS_DIR = join(homedir(), '.soul-hub', 'runs');
const OVERFLOW_THRESHOLD_BYTES = 2048;

mkdirSync(RUNS_DIR, { recursive: true });

/** Resolve the JSONL path for a run, taking parent linkage into account. */
function resolveJsonlPath(runId: string, parentRunId?: string): string {
	if (parentRunId) {
		return join(RUNS_DIR, parentRunId, 'subruns', `run-${runId}.jsonl`);
	}
	return join(RUNS_DIR, `${runId}.jsonl`);
}

function resolveOverflowPath(runId: string, parentRunId: string | undefined, toolUseId: string): string {
	const base = parentRunId ? join(RUNS_DIR, parentRunId, 'subruns', `run-${runId}`) : join(RUNS_DIR, runId);
	return join(base, 'tool-results', `hook-${toolUseId}-stdout.txt`);
}

export class RunEventEmitter {
	readonly runId: string;
	readonly parentRunId?: string;
	readonly jsonlPath: string;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(runId: string, parentRunId?: string) {
		this.runId = runId;
		this.parentRunId = parentRunId;
		this.jsonlPath = resolveJsonlPath(runId, parentRunId);
		mkdirSync(dirname(this.jsonlPath), { recursive: true });
	}

	/**
	 * Append one event. Caller passes the body + runId; envelope is generated.
	 * Returns a promise that resolves once this event's bytes are flushed.
	 * Fire-and-forget callers can ignore the return value.
	 */
	emit(input: Omit<SoulHubEventInput, 'runId' | 'parentRunId'>): Promise<void> {
		if (this.closed) return Promise.reject(new Error(`emitter for runId=${this.runId} is closed`));
		const event = makeEnvelope({
			runId: this.runId,
			parentRunId: this.parentRunId,
			...input,
		} as SoulHubEventInput);
		this.queue = this.queue.then(() => this.appendOne(event));
		return this.queue;
	}

	private async appendOne(event: SoulHubEvent): Promise<void> {
		try {
			await fsp.appendFile(this.jsonlPath, JSON.stringify(event) + '\n', 'utf8');
		} catch (err) {
			console.error(`[soul-hub:emitter] failed to append to ${this.jsonlPath}`, err);
		}
	}

	/**
	 * Persist a tool_result payload that exceeds OVERFLOW_THRESHOLD_BYTES.
	 * Returns the relative path (under ~/.soul-hub) to embed in
	 * `tool_result.overflowPath`, or null if the payload was small enough.
	 */
	async writeOverflow(toolUseId: string, payload: string | Buffer): Promise<string | null> {
		const bytes = Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload, 'utf8');
		if (bytes <= OVERFLOW_THRESHOLD_BYTES) return null;
		const path = resolveOverflowPath(this.runId, this.parentRunId, toolUseId);
		try {
			await fsp.mkdir(dirname(path), { recursive: true });
			await fsp.writeFile(path, payload);
			return path;
		} catch (err) {
			console.error(`[soul-hub:emitter] failed to write overflow ${path}`, err);
			return null;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.queue;
	}
}
