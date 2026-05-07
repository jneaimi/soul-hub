/** Background agent dispatch for Telegram.
 *
 *  Mirrors the spirit of `src/lib/orchestrator/worker.ts:runInBackground`
 *  but uses Telegram outbound instead of Baileys. Slimmer than the
 *  WhatsApp version: no 60s check-in (Telegram users get faster
 *  notifications natively), no media-artefact split (vault links are
 *  appended to the result body), and no capacity gate (single-user
 *  app — overlap is rare and the active-run registry already
 *  short-circuits cancel-by-message). The 'still running' UX comes
 *  from edit-in-place on the original ack message.
 *
 *  Flow:
 *   1. Send "🟡 Running *agentId*…" ack → capture message_id
 *   2. Run `dispatchAgent` generator
 *   3. On `started` event → register in active-run registry so
 *      cancel-by-message works
 *   4. On terminal status → edit ack ("✅ done" / "❌ failed") and
 *      send the result body as a follow-up message (so it doesn't
 *      get truncated against Telegram's 4096-char message limit) */

import { dispatchAgent } from '../../agents/dispatch/index.js';
import { setActive, clearActive } from '../../orchestrator/active-runs.js';
import { editText, sendText } from './outbound.js';
import type { TelegramDeliveryConfig } from './types.js';

const DEFAULT_DURATION_DISPLAY_THRESHOLD_MS = 1000;

interface DispatchArgs {
	chatId: string;
	agentId: string;
	task: string;
	sourceMessage: string;
	conversationKey: string;
	delivery: TelegramDeliveryConfig;
	agentContext?: string;
}

/** Fire-and-forget — caller must not await. The promise is intentionally
 *  detached so any error caught inside this function surfaces as a
 *  best-effort message back to the chat rather than throwing into the
 *  webhook handler's response loop. */
export function runInBackground(args: DispatchArgs): void {
	const {
		chatId,
		agentId,
		task,
		sourceMessage,
		conversationKey,
		delivery,
		agentContext,
	} = args;

	const controller = new AbortController();
	const startedAt = Date.now();
	let registered = false;
	let registeredRunId = '';
	let ackMessageId: number | null = null;

	void (async () => {
		// 1. Initial ack — capture messageId for later edits.
		const ack = await sendText(
			chatId,
			`🟡 Running *${agentId}*…\nReply *cancel* to stop.`,
			delivery,
		);
		if (ack.ok && ack.messageIds.length > 0) {
			ackMessageId = ack.messageIds[0];
		}

		const generator = dispatchAgent(agentId, task, {
			jid: chatId,
			sourceMessage,
			signal: controller.signal,
			mode: 'production',
			context: agentContext,
		});

		try {
			let next = await generator.next();
			while (!next.done) {
				const event = next.value;
				if (event.type === 'started') {
					registeredRunId = event.runId;
					setActive({
						runId: registeredRunId,
						agentId,
						jid: chatId,
						startedAt,
						abortController: controller,
					});
					registered = true;
				}
				next = await generator.next();
			}

			const result = next.value;
			const durationMs = Date.now() - startedAt;
			const durationDisplay = formatDuration(durationMs);

			if (result.status === 'success') {
				if (ackMessageId) {
					await editText(
						chatId,
						ackMessageId,
						`✅ *${agentId}* done in ${durationDisplay}.`,
						delivery.parseMode,
					).catch(() => {
						/* edit failure shouldn't block the result body */
					});
				}
				const body = result.output?.trim();
				if (body && body.length > 0) {
					await sendText(chatId, body, delivery);
				}
			} else if (result.status === 'cancelled') {
				if (ackMessageId) {
					await editText(
						chatId,
						ackMessageId,
						`🛑 *${agentId}* cancelled after ${durationDisplay}.`,
						delivery.parseMode,
					).catch(() => {});
				}
			} else {
				const reason = result.error?.slice(0, 240) ?? result.status;
				if (ackMessageId) {
					await editText(
						chatId,
						ackMessageId,
						`❌ *${agentId}* failed after ${durationDisplay}: ${reason}`,
						delivery.parseMode,
					).catch(() => {});
				} else {
					await sendText(
						chatId,
						`❌ *${agentId}* failed: ${reason}`,
						delivery,
					);
				}
			}
		} catch (err) {
			const message = (err as Error).message;
			console.warn(`[telegram/orchestrator] dispatch threw: ${message}`);
			if (ackMessageId) {
				await editText(
					chatId,
					ackMessageId,
					`❌ *${agentId}* errored: ${message.slice(0, 240)}`,
					delivery.parseMode,
				).catch(() => {});
			}
		} finally {
			if (registered) {
				clearActive(registeredRunId);
			}
		}
	})();
}

function formatDuration(ms: number): string {
	if (ms < DEFAULT_DURATION_DISPLAY_THRESHOLD_MS) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}
