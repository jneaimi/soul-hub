/**
 * Background dispatch worker for slow orchestrator-v2 tools (ADR-030).
 *
 * Sibling to `runInBackground` (agent dispatch). The shape is similar
 * but the unit-of-work is a tool's `execute()` closure + a formatter
 * that turns the structured result into chat-ready prose — there's no
 * `dispatchAgent`/PTY/agent_runs row involved.
 *
 * Flow per turn:
 *   1. The channel handler has already sent a presence bubble (e.g.
 *      "🟡 Fetching YouTube video…") and captured its `messageId`.
 *   2. The slow tool's execute() called `runSkillInBackground` and
 *      returned `kind: 'slow-dispatched'` immediately — the LLM step
 *      sees this and the channel handler skips its final reply send.
 *   3. This worker awaits `executeFn()`, formats the structured result
 *      via `formatFn`, and edits the bubble's `progressMessageId`
 *      in place. If the body exceeds the edit cap, the bubble gets a
 *      short status line and the full body lands as a follow-up.
 *
 * Cancellation: registers in `active-runs` keyed by a synthetic runId
 * (`skill:<toolName>:<rand>`), so `cancelByJid(jid)` reaches it.
 *
 * v1 scope: WhatsApp only. Telegram callers don't populate
 * `slowDispatch.worker` — slow tools degrade to inline on that channel.
 */

import { workerSend } from '$lib/channels/whatsapp/worker-client.js';
import type { WhatsAppWorkerConfig } from '$lib/channels/whatsapp/types.js';
import { saveTurn } from '$lib/vault-chat/history.js';
import { setActive, clearActive } from './active-runs.js';

export interface RunSkillInBackgroundArgs {
	jid: string;
	channel: 'whatsapp' | 'telegram';
	toolName: string;
	worker?: unknown;
	/** Channel-side bubble id from the presence layer — edited in place
	 *  with the formatted result. Omit to send a fresh message instead. */
	progressMessageId?: string;
	conversationKey?: string;
	/** Runs the actual tool work. Resolves to the tool's structured
	 *  result; rejects on failure. The closure should capture all args
	 *  it needs — `runSkillInBackground` is opaque to tool internals. */
	executeFn: () => Promise<unknown>;
	/** Turns the structured result into chat-ready text. Called only on
	 *  success — error/timeout paths emit their own message. */
	formatFn: (result: unknown) => string;
	/** Caller-provided cap. Defaults to 120s — youtubeFetch summary
	 *  observed at 20-60s, transcript up to 90s with retries. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_EDIT_BODY_CHARS = 1800;

/** Fire-and-forget. Caller does NOT await. Errors are caught and
 *  surfaced to the chat — never thrown back to the caller's loop. */
export function runSkillInBackground(args: RunSkillInBackgroundArgs): void {
	const {
		jid,
		channel,
		toolName,
		worker,
		progressMessageId,
		conversationKey,
		executeFn,
		formatFn,
		timeoutMs,
	} = args;

	if (channel !== 'whatsapp') {
		console.warn(
			`[skill-worker] slow dispatch only supports WhatsApp in v1; ${toolName} on ${channel} degraded to inline upstream`,
		);
		return;
	}
	if (!worker || typeof worker !== 'object') {
		console.warn(`[skill-worker] missing worker handle for ${toolName}; aborting background dispatch`);
		return;
	}
	const waWorker = worker as WhatsAppWorkerConfig;

	const controller = new AbortController();
	const startedAt = Date.now();
	const runId = `skill:${toolName}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	setActive({ runId, agentId: `skill:${toolName}`, jid, startedAt, abortController: controller });

	const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

	void (async () => {
		try {
			const result = await executeFn();
			if (controller.signal.aborted) {
				await deliverEdit(waWorker, jid, progressMessageId, `🚫 *${toolName}* — cancelled.`);
				return;
			}
			const body = formatFn(result);
			const finalText = body.length > MAX_EDIT_BODY_CHARS
				? body.slice(0, MAX_EDIT_BODY_CHARS - 16) + '\n…(truncated)'
				: body;
			await deliverEdit(waWorker, jid, progressMessageId, finalText);

			if (conversationKey) {
				try {
					saveTurn(conversationKey, 'assistant', finalText);
				} catch (err) {
					console.warn(
						`[skill-worker] chat_history save failed for ${toolName}: ${(err as Error).message}`,
					);
				}
			}
		} catch (err) {
			const aborted = controller.signal.aborted;
			const message = aborted
				? `🚫 *${toolName}* — cancelled or timed out.`
				: `⚠️ *${toolName}* — ${(err as Error).message}`;
			await deliverEdit(waWorker, jid, progressMessageId, message);
		} finally {
			clearTimeout(timeoutHandle);
			clearActive(runId);
		}
	})();
}

async function deliverEdit(
	worker: WhatsAppWorkerConfig,
	jid: string,
	editId: string | undefined,
	text: string,
): Promise<void> {
	try {
		if (editId) {
			await workerSend(worker, { to: jid, editId, text });
		} else {
			await workerSend(worker, { to: jid, text });
		}
	} catch (err) {
		console.error(
			`[skill-worker] settle send failed for jid=${jid} editId=${editId ?? 'none'}: ${(err as Error).message}`,
		);
	}
}
