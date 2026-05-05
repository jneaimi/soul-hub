/**
 * Background dispatch worker — runs the agent via `dispatchAgent` and
 * morphs a single WhatsApp status message via Baileys edits as the run
 * progresses (ADR-005 Phase 2).
 *
 * Contract with the inbound handler:
 *   - The handler synchronously sends the initial "🟡 Working on it…"
 *     message via `workerSend` and captures the resulting `messageId`.
 *   - It then calls `runInBackground({progressMessageId, …})` and returns
 *     `{action: 'drop'}` so the worker process doesn't double-send.
 *   - This module owns the message from then on: edits it through the
 *     run, settles it on terminal status. If the run output exceeds the
 *     edit-friendly size (~3.5KB), the status message is settled to a
 *     short summary and the full output is sent as a follow-up message.
 *
 * Throttle: at most one edit per `EDIT_THROTTLE_MS`. `step` events bypass
 * the throttle (they are inherently milestoned). Final/terminal edits
 * always fire.
 */

import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import type { DispatchEvent, DispatchResult } from '$lib/agents/dispatch/types.js';
import { workerSend } from '$lib/channels/whatsapp/worker-client.js';
import type { WhatsAppWorkerConfig } from '$lib/channels/whatsapp/types.js';
import { setActive, clearActive } from './active-runs.js';

export interface RunInBackgroundArgs {
	jid: string;
	agentId: string;
	task: string;
	sourceMessage: string;
	worker: WhatsAppWorkerConfig;
	/** ID of the WhatsApp message the inbound handler just sent (the
	 *  "🟡 Working on it…" ack). The progress callback edits this same
	 *  message in place. When undefined, progress edits are skipped and
	 *  only the final result lands as a fresh message — keeps the path
	 *  alive if the initial send failed for any reason. */
	progressMessageId?: string;
}

const EDIT_THROTTLE_MS = 8_000;
const REPLY_LIMIT_CHARS = 3_500; // WhatsApp text cap is ~4096; leave headroom.
const STATUS_LINE_MAX = 200;

function elapsedSec(startedAt: number): number {
	return Math.round((Date.now() - startedAt) / 1000);
}

function progressLine(agentId: string, startedAt: number, stepCount: number): string {
	const sec = elapsedSec(startedAt);
	const stepBit = stepCount > 0 ? ` · step ${stepCount}` : '';
	return `🟡 Working on \`${agentId}\` (${sec}s${stepBit})…`;
}

function terminalLine(agentId: string, result: DispatchResult): string {
	const prefix =
		result.status === 'success'
			? `✅ \`${agentId}\` finished`
			: result.status === 'cancelled'
				? `🛑 \`${agentId}\` cancelled`
				: result.status === 'timeout'
					? `⏱ \`${agentId}\` timed out`
					: result.status === 'budget-exceeded'
						? `💸 \`${agentId}\` hit its budget`
						: `⚠️ \`${agentId}\` errored`;

	const cost = result.cost_usd > 0 ? ` · $${result.cost_usd.toFixed(4)}` : '';
	const turns = result.num_turns ? ` · ${result.num_turns} turns` : '';
	const dur = `${(result.duration_ms / 1000).toFixed(1)}s`;
	return `${prefix} (${dur}${turns}${cost})`;
}

/** Settle the run: edit the status message, send the full output as a
 *  follow-up if it doesn't fit cleanly inside the edit. */
async function settleRun(args: {
	jid: string;
	agentId: string;
	worker: WhatsAppWorkerConfig;
	progressMessageId?: string;
	result: DispatchResult;
}): Promise<void> {
	const { jid, agentId, worker, progressMessageId, result } = args;
	const status = terminalLine(agentId, result);
	const body =
		result.status === 'success'
			? (result.output || '(no output)').slice(0, REPLY_LIMIT_CHARS)
			: (result.error || '(no detail)').slice(0, REPLY_LIMIT_CHARS);

	// If the body fits inside a single edit (status + body together under
	// the cap), morph the original message and we're done. Otherwise
	// settle the original to a short status line and ship the body as a
	// fresh follow-up message.
	const combined = `${status}\n\n${body}`;
	if (progressMessageId && combined.length <= REPLY_LIMIT_CHARS) {
		try {
			await workerSend(worker, { to: jid, editId: progressMessageId, text: combined });
		} catch (err) {
			console.error(
				`[orchestrator] settle-edit failed for ${jid}: ${(err as Error).message}`,
			);
			// Fall back to a fresh message so the user still sees something.
			try {
				await workerSend(worker, { to: jid, text: combined });
			} catch (err2) {
				console.error(
					`[orchestrator] settle-fallback also failed for ${jid}: ${(err2 as Error).message}`,
				);
			}
		}
		return;
	}

	if (progressMessageId) {
		try {
			await workerSend(worker, { to: jid, editId: progressMessageId, text: status });
		} catch (err) {
			console.error(
				`[orchestrator] settle-status-edit failed for ${jid}: ${(err as Error).message}`,
			);
		}
	}
	try {
		await workerSend(worker, { to: jid, text: body });
	} catch (err) {
		console.error(
			`[orchestrator] settle-body-send failed for ${jid}: ${(err as Error).message}`,
		);
	}
}

/** Run the dispatch in the background. Caller does NOT await. Errors
 *  swallowed and surfaced as a failure message to the chat — never
 *  thrown back to the caller's request loop. */
export function runInBackground(args: RunInBackgroundArgs): void {
	const { jid, agentId, task, sourceMessage, worker, progressMessageId } = args;

	const controller = new AbortController();
	const startedAt = Date.now();
	let stepCount = 0;
	let lastEditAt = 0;
	let lastStatusLine = '';

	const editProgress = async (force = false): Promise<void> => {
		if (!progressMessageId) return;
		const now = Date.now();
		if (!force && now - lastEditAt < EDIT_THROTTLE_MS) return;
		const line = progressLine(agentId, startedAt, stepCount).slice(0, STATUS_LINE_MAX);
		if (line === lastStatusLine) return;
		lastEditAt = now;
		lastStatusLine = line;
		try {
			await workerSend(worker, { to: jid, editId: progressMessageId, text: line });
		} catch (err) {
			// Edit failed (rare) — drop the throttle so subsequent edits
			// retry, but don't surface the error to the user. Best-effort.
			console.warn(
				`[orchestrator] progress edit failed for ${jid}: ${(err as Error).message}`,
			);
		}
	};

	void (async () => {
		const generator = dispatchAgent(agentId, task, {
			jid,
			sourceMessage,
			signal: controller.signal,
			mode: 'production',
		});

		let runId = '';
		let result: DispatchResult | undefined;

		try {
			let next = await generator.next();
			while (!next.done) {
				const event = next.value as DispatchEvent;
				if (event.type === 'started') {
					runId = event.runId;
					setActive(jid, { runId, agentId, startedAt, abortController: controller });
				} else if (event.type === 'step') {
					stepCount = event.n;
					// Step events are inherently milestoned — bypass throttle.
					await editProgress(true);
				} else if (event.type === 'output') {
					// Output chunks are too noisy to act on; just refresh
					// the elapsed-time line if the throttle window is up.
					await editProgress(false);
				}
				next = await generator.next();
			}
			result = next.value;
		} catch (err) {
			result = {
				runId,
				agentId,
				backend: 'claude-pty',
				status: 'error',
				output: '',
				cost_usd: 0,
				num_turns: 0,
				duration_ms: Date.now() - startedAt,
				error: (err as Error).message,
			};
		} finally {
			clearActive(jid);
		}

		await settleRun({ jid, agentId, worker, progressMessageId, result });
	})();
}
