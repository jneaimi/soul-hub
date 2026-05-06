/**
 * Background dispatch worker — runs the agent via `dispatchAgent` and
 * settles the WhatsApp ack message when the run terminates.
 *
 * Phase 1.5a UX rewrite:
 *   - The handler synchronously sends a single conversational ack
 *     ("On it — delegating to *agent*. I'll send the summary…") and
 *     captures its `messageId`.
 *   - This module owns the message from then on: leaves it untouched
 *     during the run (no 8s edit cadence — the previous behavior spammed
 *     the user with progress lines), fires ONE optional 60s check-in as
 *     a SEPARATE message if the run is still alive, then settles the
 *     original ack with terminal status on completion.
 *   - On settle, agent stdout is run through `cleanAgentOutputForChat`
 *     (ANSI/box-draw stripping + banner-line removal). A best-effort
 *     vault-path extraction renders a clickable Soul Hub URL in a
 *     follow-up message so the user can pull the long-form report.
 *
 * Cancel: the abort controller is registered in `active-runs` keyed by
 * `runId`. `cancelByJid(jid)` aborts every run on the JID; the dispatch
 * generator's catch-block produces a `cancelled` result and we settle
 * the message.
 */

import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import type { DispatchEvent, DispatchResult } from '$lib/agents/dispatch/types.js';
import { workerSend } from '$lib/channels/whatsapp/worker-client.js';
import type { WhatsAppWorkerConfig } from '$lib/channels/whatsapp/types.js';
import { saveTurn } from '$lib/vault-chat/history.js';
import {
	summarizeAgentResultForHistory,
	cleanAgentOutputForChat,
	extractVaultPath,
} from '$lib/conversation/index.js';
import { setActive, clearActive, listActiveByJid } from './active-runs.js';
import {
	extractMediaArtefacts,
	pickCaptionTarget,
	CAPTION_LIMIT_CHARS,
} from './media-output.js';

export interface RunInBackgroundArgs {
	jid: string;
	agentId: string;
	task: string;
	sourceMessage: string;
	worker: WhatsAppWorkerConfig;
	/** ID of the WhatsApp message the inbound handler just sent (the
	 *  conversational ack). The settle step edits this same message in
	 *  place when the run finishes. When undefined, the settle path falls
	 *  back to a fresh message — keeps the path alive if the initial send
	 *  failed for any reason. */
	progressMessageId?: string;
	/** Phase 5 — conversation key (DM senderNumber, group chatJid). Used to
	 *  write a one-line agent-result summary to `chat_history` when the run
	 *  settles, so the next conversational turn (in either the orchestrator
	 *  or vault-chat) sees that this agent ran and what it answered. */
	conversationKey?: string;
	/** Phase 5 — orchestrator-built brief inlined into the agent's task
	 *  prompt at dispatch time. Bounded ~600 chars upstream by
	 *  `buildAgentContextBrief`. */
	agentContext?: string;
}

const REPLY_LIMIT_CHARS = 3_500; // WhatsApp text cap is ~4096; leave headroom.
const STILL_RUNNING_CHECKIN_MS = 60_000;

function terminalLine(agentId: string, result: DispatchResult): string {
	const prefix =
		result.status === 'success'
			? `✅ *${agentId}* finished`
			: result.status === 'cancelled'
				? `🛑 *${agentId}* cancelled`
				: result.status === 'timeout'
					? `⏱ *${agentId}* timed out`
					: result.status === 'budget-exceeded'
						? `💸 *${agentId}* hit its budget`
						: `⚠️ *${agentId}* errored`;

	const cost = result.cost_usd > 0 ? ` · $${result.cost_usd.toFixed(4)}` : '';
	const turns = result.num_turns ? ` · ${result.num_turns} turns` : '';
	const dur = `${(result.duration_ms / 1000).toFixed(1)}s`;
	return `${prefix} (${dur}${turns}${cost})`;
}

/** Build the chat-friendly body for a settled run. Success runs get the
 *  ANSI-cleaned output; failure / timeout runs get a single-line reason.
 *  Cancel returns empty so the caller skips the body send — the cancel
 *  handler in `_inbound/+server.ts` already replied "🛑 Cancelled
 *  *agent*." and the status edit shows "🛑 agent cancelled (Xs)". A
 *  third "Stopped on your request." would be redundant. */
function settleBody(result: DispatchResult): string {
	if (result.status === 'success') {
		const cleaned = cleanAgentOutputForChat(result.output, REPLY_LIMIT_CHARS);
		return cleaned || '(no readable output — full result saved to the vault)';
	}
	if (result.status === 'cancelled') return '';
	if (result.status === 'timeout') {
		return `Timed out at ${(result.duration_ms / 1000).toFixed(0)}s. Partial output (if any) saved to the vault.`;
	}
	if (result.status === 'budget-exceeded') {
		return `Hit cost / turn budget. Partial output (if any) saved to the vault.`;
	}
	return result.error ? result.error.slice(0, 500) : 'Unknown error.';
}

/** Render a clickable vault URL for a given vault-relative path, or null
 *  if `SOUL_HUB_PUBLIC_URL` is not configured. The /vault?note=… form is
 *  what the rest of the app uses (see _inbound's "more" handler). */
function vaultUrl(vaultRelPath: string): string | null {
	const base = (process.env.SOUL_HUB_PUBLIC_URL ?? '').replace(/\/$/, '');
	if (!base) return null;
	return `${base}/vault?note=${encodeURIComponent(vaultRelPath)}`;
}

/** Settle the run: edit the original ack to a terminal status line, and
 *  send the cleaned body (+ optional vault URL) as one or two follow-up
 *  messages. We never try to cram everything into the edit anymore — the
 *  body is multi-line cleaned text and edits beyond a few hundred chars
 *  read poorly across WhatsApp clients. */
async function settleRun(args: {
	jid: string;
	agentId: string;
	worker: WhatsAppWorkerConfig;
	progressMessageId?: string;
	result: DispatchResult;
}): Promise<void> {
	const { jid, agentId, worker, progressMessageId, result } = args;
	const status = terminalLine(agentId, result);

	if (progressMessageId) {
		try {
			await workerSend(worker, { to: jid, editId: progressMessageId, text: status });
		} catch (err) {
			console.error(
				`[orchestrator] settle-status-edit failed for ${jid}: ${(err as Error).message}`,
			);
		}
	} else {
		try {
			await workerSend(worker, { to: jid, text: status });
		} catch (err) {
			console.error(
				`[orchestrator] settle-status-send failed for ${jid}: ${(err as Error).message}`,
			);
		}
	}

	const body = settleBody(result);

	// ADR-006 Phase 2 — media-aware settle. When the agent produced media
	// artefacts (image / video / audio / voice notes), deliver them as
	// Baileys media instead of (or in addition to) the text body. The
	// chat-trailer summary becomes a caption on the first image/video, or
	// a leading text message when the artefacts are audio-only. The vault
	// link is suppressed because the artefacts ARE the deliverables.
	const artefacts =
		result.status === 'success' && result.output ? extractMediaArtefacts(result.output) : [];

	if (artefacts.length > 0) {
		const captionIdx = pickCaptionTarget(artefacts);
		const captionFits = body.length > 0 && body.length <= CAPTION_LIMIT_CHARS;
		// If the body is too long for a caption OR there's no image/video
		// to attach the caption to, send the body as a separate text first.
		if (body.length > 0 && (!captionFits || captionIdx === -1)) {
			try {
				await workerSend(worker, { to: jid, text: body });
			} catch (err) {
				console.error(
					`[orchestrator] settle-body-send failed for ${jid}: ${(err as Error).message}`,
				);
			}
		}
		for (let i = 0; i < artefacts.length; i++) {
			const a = artefacts[i];
			const useCaption = i === captionIdx && captionFits && captionIdx !== -1;
			try {
				await workerSend(worker, {
					to: jid,
					attachPath: a.path,
					kind: a.kind,
					caption: useCaption ? body : undefined,
				});
			} catch (err) {
				console.error(
					`[orchestrator] media-send failed for ${jid} (${a.kind}): ${(err as Error).message}`,
				);
			}
		}
		return;
	}

	if (body && body.length > 0) {
		try {
			await workerSend(worker, { to: jid, text: body });
		} catch (err) {
			console.error(
				`[orchestrator] settle-body-send failed for ${jid}: ${(err as Error).message}`,
			);
		}
	}

	// Best-effort vault link. Heuristic Phase 1.5a — Phase 1.5b will pull
	// it from the structured trailer once agents emit one. Skipped on the
	// media-artefact path above (the artefacts are the deliverables).
	if (result.status === 'success' && result.output) {
		const path = extractVaultPath(result.output);
		const url = path ? vaultUrl(path) : null;
		if (url) {
			try {
				await workerSend(worker, { to: jid, text: `📄 Full report: ${url}` });
			} catch (err) {
				console.warn(
					`[orchestrator] vault-link send failed for ${jid}: ${(err as Error).message}`,
				);
			}
		}
	}
}

/** Run the dispatch in the background. Caller does NOT await. Errors
 *  swallowed and surfaced as a failure message to the chat — never
 *  thrown back to the caller's request loop. */
export function runInBackground(args: RunInBackgroundArgs): void {
	const { jid, agentId, task, sourceMessage, worker, progressMessageId, conversationKey, agentContext } = args;

	const controller = new AbortController();
	const startedAt = Date.now();
	let registered = false;
	let registeredRunId = '';
	let terminated = false;

	// Single 60s check-in. Sent as a separate message so the user notices
	// it; previous design edited the ack every 8s and produced a wall of
	// pings. After this fires once, silence until terminal.
	//
	// Disambiguation: when another run of the SAME agent is already alive on
	// this JID at fire time, the per-agent name in "Still working on
	// *researcher*" is ambiguous (two researcher runs send identical
	// pings). The cap-rejection message at dispatch time already told the
	// user there are multiple runs, so we suppress the redundant check-in
	// instead of emitting an ambiguous one. A solo run still gets it.
	const checkInTimer = setTimeout(() => {
		if (terminated) return;
		const peers = listActiveByJid(jid).filter(
			(r) => r.agentId === agentId && r.runId !== registeredRunId,
		);
		if (peers.length > 0) {
			return;
		}
		void workerSend(worker, {
			to: jid,
			text: `Still working on *${agentId}* — 60s in. Reply *cancel* to stop, or wait — I'll send the summary here.`,
		}).catch((err) => {
			console.warn(
				`[orchestrator] 60s check-in failed for ${jid}: ${(err as Error).message}`,
			);
		});
	}, STILL_RUNNING_CHECKIN_MS);

	void (async () => {
		const generator = dispatchAgent(agentId, task, {
			jid,
			sourceMessage,
			signal: controller.signal,
			mode: 'production',
			context: agentContext,
		});

		let runId = '';
		let result: DispatchResult | undefined;

		try {
			let next = await generator.next();
			while (!next.done) {
				const event = next.value as DispatchEvent;
				if (event.type === 'started') {
					runId = event.runId;
					registeredRunId = runId;
					setActive({ runId, agentId, jid, startedAt, abortController: controller });
					registered = true;
				}
				// Other events (`step`, `output`, `tool_call`, etc.) intentionally
				// no-op here — Phase 1.5a removed mid-run progress edits.
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
			terminated = true;
			clearTimeout(checkInTimer);
			if (registered) clearActive(registeredRunId);
		}

		await settleRun({ jid, agentId, worker, progressMessageId, result });

		// Phase 5 — write the assistant turn to chat_history so the next
		// conversational turn (orchestrator or vault-chat) sees the gist of
		// what this agent produced. The raw output already lives in
		// `agent_runs.output`; this is a thin anchor for anaphora resolution.
		// Best-effort: a write failure must not break the dispatch path.
		if (conversationKey) {
			try {
				const summary = summarizeAgentResultForHistory(
					agentId,
					result.output,
					result.error,
					result.status,
				);
				saveTurn(conversationKey, 'assistant', summary);
			} catch (err) {
				console.warn(
					`[orchestrator] chat_history writeback failed for ${conversationKey}: ${(err as Error).message}`,
				);
			}
		}
	})();
}
