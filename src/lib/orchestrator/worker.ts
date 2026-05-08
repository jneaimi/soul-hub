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
	hasChatTrailer,
} from '$lib/conversation/index.js';
import { setActive, clearActive, listActiveByJid } from './active-runs.js';
import {
	extractMediaArtefacts,
	pickCaptionTarget,
	CAPTION_LIMIT_CHARS,
} from './media-output.js';
import { bindLatestConfirmed } from './proposal-history.js';

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

// 2026-05-06: when an agent finishes "successfully" but actually stopped
// to ask for clarification (instead of producing real work), the cleaned
// output is short and contains tell-tale phrases. Detect this and surface
// a friendly retry prompt instead of leaking the half-formed dump.
const CLARIFICATION_PHRASES = [
	/I\s+need\s+to\s+clarify/i,
	/Let\s+me\s+(?:ask|clarify|check)/i,
	/[Cc]ould\s+you\s+(?:clarify|specify|tell\s+me)/i,
	/[Ww]hat\s+(?:text|content|style|theme|colou?r)\s+would\s+you\s+like/i,
	/[Bb]efore\s+(?:I\s+)?generat(?:e|ing)/i,
	/(?:more|additional)\s+(?:detail|information|context)\s+(?:needed|required)/i,
];

// 2026-05-06: even after the cleaner runs, sometimes the captured output
// is mostly Claude Code splash / paste-buffer / release-note noise that
// got past every individual filter. Detect "agent never actually started
// real work" by looking for splash signatures — independent of length.
const SPLASH_SIGNATURES = [
	/Welcome\s+back\s+\w+/i,
	/What['']s\s+new/i,
	/release[-\s]?notes\s+for\s+more/i,
	/\[Pasted\s+text\s+#\d+\s+\+\d+\s+lines?\]/i,
	/Try\s+["“]refactor\s+<[^>]+>/i,
];

function looksLikeClarificationStop(cleaned: string): boolean {
	if (cleaned.length > 800) return false; // a real run with >800 chars of output isn't a stop-to-ask
	return CLARIFICATION_PHRASES.some((re) => re.test(cleaned));
}

/** Detect "the captured output is overwhelmingly Claude Code splash /
 *  paste-buffer noise — the agent never actually did work." Independent of
 *  length: even a 3000-char dump of welcome-screen / release-notes /
 *  pasted-content elision markers should trigger the retry prompt. */
function looksLikeSplashOnly(cleaned: string): boolean {
	if (!cleaned) return false;
	let hits = 0;
	for (const re of SPLASH_SIGNATURES) if (re.test(cleaned)) hits++;
	// Two or more independent splash signatures → high confidence the
	// output is TUI-only. One signature isn't enough (a real reply might
	// genuinely mention "release notes" in passing).
	return hits >= 2;
}

/** Build the chat-friendly body for a settled run. Success runs get the
 *  ANSI-cleaned output; failure / timeout runs get a single-line reason.
 *  Cancel returns empty so the caller skips the body send — the cancel
 *  handler in `_inbound/+server.ts` already replied "🛑 Cancelled
 *  *agent*." and the status edit shows "🛑 agent cancelled (Xs)". A
 *  third "Stopped on your request." would be redundant.
 *
 *  ADR-006 post-ship: when status=success but the agent has no artefacts
 *  AND the cleaned body is empty or looks like a clarification stop,
 *  surface a friendly retry prompt instead of the leaked dump.
 *
 *  ADR-018 follow-up (2026-05-08): when an artefact was produced but the
 *  agent forgot the `---CHAT---` trailer (common with the heavier author
 *  agent on multi-turn katib runs), `cleanAgentOutputForChat` falls back
 *  to whole-output cleaning — which leaks the full PTY transcript into
 *  chat. The artefact + status edit + vault link already tell the full
 *  story; suppress the body entirely in that case. */
function settleBody(result: DispatchResult, artefactCount: number): string {
	if (result.status === 'success') {
		const cleaned = cleanAgentOutputForChat(result.output, REPLY_LIMIT_CHARS);
		if (artefactCount > 0) {
			if (!hasChatTrailer(result.output)) return '';
			return cleaned;
		}
		if (!cleaned || cleaned.length < 30) {
			return `*${result.agentId}* finished but didn't produce a deliverable. Try again with more specifics — e.g. "image of a Dubai skyline with the temperature 34°C overlaid bottom-center".`;
		}
		if (looksLikeSplashOnly(cleaned)) {
			return `*${result.agentId}* didn't actually start work — the agent session captured only Claude Code's splash screen. This is usually transient; please retry. If it persists, the PTY backend may need a reset.`;
		}
		if (looksLikeClarificationStop(cleaned)) {
			return `*${result.agentId}* stopped to ask for clarification mid-run. Headless agents can't ask follow-up questions — please retry with the missing detail baked into the request.`;
		}
		return cleaned;
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

	// ADR-006 Phase 2 — media-aware settle. When the agent produced media
	// artefacts (image / video / audio / voice notes), deliver them as
	// Baileys media instead of (or in addition to) the text body. The
	// chat-trailer summary becomes a caption on the first image/video, or
	// a leading text message when the artefacts are audio-only. The vault
	// link is suppressed because the artefacts ARE the deliverables.
	const artefacts =
		result.status === 'success' && result.output ? extractMediaArtefacts(result.output) : [];

	// `settleBody` needs the artefact count to decide between leaking a
	// half-formed clarification stop and surfacing a friendly retry prompt
	// — see post-ship guard in the helper.
	const body = settleBody(result, artefacts.length);

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
	// Tracks the in-flight check-in send. The settle path awaits this BEFORE
	// emitting the terminal status edit, so WhatsApp always shows the
	// "still working" line — if it fired at all — strictly before the
	// "✅ finished" line. Without this guard the two messages race over
	// the Baileys socket and arrive out of order.
	let checkInSendPromise: Promise<unknown> | null = null;

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
		// Re-check terminated right before the send — covers the race where
		// the run completed in the microtask gap between setTimeout firing
		// and the callback running.
		if (terminated) return;
		const peers = listActiveByJid(jid).filter(
			(r) => r.agentId === agentId && r.runId !== registeredRunId,
		);
		if (peers.length > 0) {
			return;
		}
		checkInSendPromise = workerSend(worker, {
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
					// Proposal-history bind happens in the settle path so the
					// runId is final (matches the agent_runs row).
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

		// If the 60s check-in was already in flight when the run completed,
		// wait for it to land before sending the terminal status edit so the
		// chat sees "still working" then "finished" in the right order.
		if (checkInSendPromise) {
			try {
				await checkInSendPromise;
			} catch {
				/* check-in send already logs its own failure; ignore */
			}
		}

		await settleRun({ jid, agentId, worker, progressMessageId, result });

		if (conversationKey && runId) {
			// Bind the runId to the most recent confirmed proposal_history
			// row so analytics can join `agent_runs.run_id` ↔ proposal audit.
			// No-op when there's no runId (failure-before-start) or when the
			// dispatch fired without going through propose-confirm.
			// Best-effort — never throws to the worker loop.
			try {
				bindLatestConfirmed(conversationKey, agentId, runId);
			} catch (err) {
				console.warn(
					`[orchestrator] proposal-history bind failed for ${conversationKey}: ${(err as Error).message}`,
				);
			}

			// Anchor the agent result into chat_history so the next
			// conversational turn sees the gist of what ran. The raw output
			// already lives in `agent_runs.output`; this is a thin summary
			// for anaphora resolution. Best-effort.
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
