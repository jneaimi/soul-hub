/**
 * Background dispatch worker — given an orchestrator decision, runs the
 * agent via `dispatchAgent` and posts the result back to the chat via
 * the WhatsApp worker `/send` endpoint.
 *
 * Phase 1 contract: fire-and-forget. The inbound handler returns the
 * "Working on it..." ack synchronously; this function runs in the
 * background and posts a follow-up message when the dispatch terminates.
 *
 * Phase 2 will swap in message editing once Baileys edit support is
 * verified in the worker process.
 */

import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import type { DispatchResult } from '$lib/agents/dispatch/types.js';
import { workerSend } from '$lib/channels/whatsapp/worker-client.js';
import type { WhatsAppWorkerConfig } from '$lib/channels/whatsapp/types.js';
import { setActive, clearActive } from './active-runs.js';

export interface RunInBackgroundArgs {
	jid: string;
	agentId: string;
	task: string;
	sourceMessage: string;
	worker: WhatsAppWorkerConfig;
}

const REPLY_LIMIT_CHARS = 3_500; // WhatsApp text cap is ~4096; leave headroom for prefix.

function formatResultMessage(agentId: string, result: DispatchResult): string {
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
	const meta = `${prefix} (${dur}${turns}${cost})`;

	const body =
		result.status === 'success'
			? (result.output || '(no output)').slice(0, REPLY_LIMIT_CHARS)
			: (result.error || '(no detail)').slice(0, REPLY_LIMIT_CHARS);

	return `${meta}\n\n${body}`;
}

/** Run the dispatch in the background. Caller does NOT await. Errors
 *  swallowed and surfaced as a failure message to the chat — never
 *  thrown back to the caller's request loop. */
export function runInBackground(args: RunInBackgroundArgs): void {
	const { jid, agentId, task, sourceMessage, worker } = args;

	const controller = new AbortController();
	const startedAt = Date.now();

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
				const event = next.value;
				if (event.type === 'started') {
					runId = event.runId;
					setActive(jid, { runId, agentId, startedAt, abortController: controller });
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

		const text = formatResultMessage(agentId, result);
		try {
			await workerSend(worker, { to: jid, text });
		} catch (err) {
			console.error(
				`[orchestrator] failed to post follow-up to ${jid}: ${(err as Error).message}`,
			);
		}
	})();
}
