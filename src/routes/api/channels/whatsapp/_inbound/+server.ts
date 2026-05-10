/** POST /api/channels/whatsapp/_inbound — internal callback used by the
 *  `soul-hub-whatsapp` worker process to deliver an inbound message
 *  envelope back to the main app. The main app runs the routes layer
 *  and POSTs the reply to the worker's `/send` endpoint.
 *
 *  Wire format (request body):
 *    {
 *      envelope: InboundEnvelope,
 *      transcript?: string,        // when worker already transcribed a voice note
 *    }
 *
 *  Response (synchronous):
 *    {
 *      ok: true,
 *      action: 'reply' | 'help' | 'drop',
 *      text?: string,              // worker should `/send` this back to the chat
 *      attachPath?: string,        // optional outbound media (rare for vault-chat)
 *    }
 *
 *  Auth: optional `Authorization: Bearer <token>` matching
 *  `channels.whatsapp.worker.bearerToken`. Default loopback-only setups
 *  skip the bearer check. */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import {
	checkAccess,
	getChannelConfig,
	resolveIntent,
	type InboundEnvelope,
	type MediaPayload,
} from '$lib/channels/whatsapp/index.js';
import { dispatchRoute, RouteNotFoundError } from '$lib/routes/index.js';
import { dispatchVaultChat } from '$lib/vault-chat/index.js';
import { decideV2 } from '$lib/orchestrator-v2/index.js';
import { flagWrongDispatch } from '$lib/orchestrator/proposal-history.js';
import { notifyWrongDispatch } from '$lib/orchestrator-v2/alerts.js';
import {
	runInBackground as orchestratorDispatch,
	listActiveByJid as listActiveOrchestratorRuns,
	cancelByJid as cancelOrchestratorRuns,
	checkCapacity as checkDispatchCapacity,
	formatCapacityRejection,
	getPending as getPendingProposal,
	resolvePending as resolvePendingProposal,
	classifyProposalReply,
	formatExpiredPrompt,
} from '$lib/orchestrator/index.js';
import { dispatchWebSearch, formatWebSearchForChat } from '$lib/web-search/index.js';
import { workerSend as workerSendForOrchestrator } from '$lib/channels/whatsapp/worker-client.js';
import { isFocusQuery, placeholderTextForRoute } from '$lib/channels/_shared/placeholder.js';
import { writeIntentDecision } from '$lib/intent/log.js';
import { normalizeSignature } from '$lib/intent/normalize.js';
import { isResetCommand, resetConversation, saveTurn } from '$lib/vault-chat/history.js';
import { getConversationContext, buildAgentContextBrief } from '$lib/conversation/index.js';
import {
	isHeartbeatMetaCommand,
	handleHeartbeatMetaCommand,
	isCommitmentsMetaCommand,
	handleCommitmentsMetaCommand,
} from '$lib/channels/whatsapp/heartbeat-commands.js';
import { extractCommitmentsAsync } from '$lib/channels/whatsapp/commitments-extractor.js';
import { dispatchBrainSave, dispatchBrainFind, dispatchBrainRecent } from '$lib/brain/index.js';
import { dispatchImg, rememberLastImage, getLastImage, rememberLastUserImage, getLastUserImage } from '$lib/img/index.js';
import {
	applyReplyAck,
	getRecentVoiceSurface,
	getImgCount,
	incrementImgCount,
	ymdInTimezone,
	type ReplyAckMethod,
} from '$lib/channels/whatsapp/heartbeat-state.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { maybeApplyRouter } from '$lib/channels/whatsapp/router.js';

interface InboundBody {
	envelope: InboundEnvelope;
	transcript?: string;
	/** Slice 0 — optional base64-encoded media bytes piggybacked from the
	 *  worker so the main app can run Gemini Flash captioning / vision /
	 *  document parsing without re-downloading from WhatsApp. The worker
	 *  caps the encoded string at 16MB (≈12MB raw) to stay under
	 *  SvelteKit's default request body limit. Slice 1 consumers will
	 *  decode this into a Buffer and persist via `engine.writeAsset()`. */
	mediaBase64?: string;
}

/** Hard cap on the encoded `mediaBase64` field. Keep in sync with
 *  MAX_ASSET_SIZE on the engine side (16MB). Mismatch would let the
 *  worker ship more bytes than the engine accepts, wasting bandwidth. */
const MAX_MEDIA_BASE64_BYTES = 16 * 1024 * 1024;

function helpReply(intentMap: Record<string, { route: string; description?: string }>): string {
	const lines: string[] = ['I do not recognise that command. Available:'];
	for (const [token, mapping] of Object.entries(intentMap)) {
		if (token === 'default') continue;
		const description = mapping.description ? ` — ${mapping.description}` : '';
		lines.push(`  ${token} → ${mapping.route}${description}`);
	}
	lines.push('');
	lines.push('Free-form messages route to `default`.');
	return lines.join('\n');
}

export const POST: RequestHandler = async ({ request }) => {
	const cfg = getChannelConfig();
	if (!cfg) throw error(400, 'WhatsApp channel not configured.');
	if (!cfg.worker.enabled) throw error(409, 'Worker mode is off — _inbound is for worker callbacks only.');

	if (cfg.worker.bearerToken) {
		const auth = request.headers.get('authorization') ?? '';
		const expected = `Bearer ${cfg.worker.bearerToken}`;
		if (auth !== expected) throw error(401, 'Bad bearer token.');
	}

	let body: InboundBody;
	try {
		body = (await request.json()) as InboundBody;
	} catch {
		throw error(400, 'Invalid JSON.');
	}

	if (typeof body.mediaBase64 === 'string' && body.mediaBase64.length > MAX_MEDIA_BASE64_BYTES) {
		throw error(413, `mediaBase64 exceeds ${MAX_MEDIA_BASE64_BYTES} bytes.`);
	}

	const envelope = body.envelope;
	if (!envelope) throw error(400, 'Missing envelope.');

	const access = checkAccess(envelope, cfg.access);
	if (!access.allow) {
		return json({ ok: true, action: 'drop' });
	}

	const workingBody = body.transcript?.trim() || envelope.body;

	// Conversation key — computed early so we can both stash the inbound
	// image cache (Slice 6 follow-up) and use it in the reset / heartbeat
	// branches below.
	const conversationKey = envelope.isGroup ? envelope.chatJid : envelope.senderNumber;

	// Inbound image cache (worker-mode mirror of dispatch.ts): when the
	// user sends an image, decode the worker-shipped `mediaBase64` once
	// and stash a copy keyed by `conversationKey` so a follow-up `/img`
	// can edit that image without re-uploading. Hoisted above the
	// no-caption ack so the cache populates even when the user just
	// dropped a photo without a caption.
	let inboundImageBuffer: Buffer | undefined;
	let inboundImageMime: string | undefined;
	if (body.mediaBase64 && envelope.media?.kind === 'image') {
		try {
			inboundImageBuffer = Buffer.from(body.mediaBase64, 'base64');
			inboundImageMime = envelope.media.mimetype;
			rememberLastUserImage(conversationKey, {
				buffer: inboundImageBuffer,
				mimetype: inboundImageMime,
			});
		} catch (err) {
			console.warn(`[_inbound] inbound image cache: decode failed: ${(err as Error).message}`);
		}
	}

	if (envelope.media && envelope.media.kind !== 'voice' && !workingBody.trim()) {
		const hint =
			envelope.media.kind === 'image'
				? `I got your image. Tell me what you want to do with it — ask a question, describe it, send \`/img <how to edit>\` to edit it, or \`/save\` to capture it to the vault.`
				: `I got your ${envelope.media.kind}. Tell me what you want to do with it — ask a question, describe it, or send \`/save\` (as a follow-up message or as the caption next time) to capture it to the vault.`;
		return json({ ok: true, action: 'reply', text: hint });
	}

	// Reset commands wipe per-key history and short-circuit before any
	// routing. Hoisted above `resolveIntent` because `/reset` etc. would
	// otherwise be treated as unknown intent-map tokens and routed to the
	// help fallback instead of the reset path.
	if (isResetCommand(workingBody)) {
		const cleared = resetConversation(conversationKey);
		return json({
			ok: true,
			action: 'reply',
			text: cleared > 0 ? "Conversation reset. What's on your mind?" : 'Already a fresh slate.',
		});
	}

	// Heartbeat meta-commands (`/heartbeat`, `/mute`, `/resume`) — same
	// rationale as reset: must short-circuit before intent resolution.
	if (isHeartbeatMetaCommand(workingBody)) {
		try {
			const reply = await handleHeartbeatMetaCommand(workingBody);
			return json({ ok: true, action: 'reply', text: reply });
		} catch (err) {
			return json({
				ok: true,
				action: 'reply',
				text: `Heartbeat command failed: ${(err as Error).message}`,
			});
		}
	}

	// Slice 5 — `/commitments [list|dismiss <id>]`. Scoped by senderNumber.
	if (isCommitmentsMetaCommand(workingBody)) {
		try {
			const reply = await handleCommitmentsMetaCommand(workingBody, envelope.senderNumber);
			return json({ ok: true, action: 'reply', text: reply });
		} catch (err) {
			return json({
				ok: true,
				action: 'reply',
				text: `Commitments command failed: ${(err as Error).message}`,
			});
		}
	}

	// Phase 4.5 + 4.6 — voice-queue reply-ack and detail-on-demand.
	// Bare "done" / "skip" / "later" (case-insensitive, single word) updates
	// the most-recent auto-acked voice-queue rows within a 4h window. Bare
	// "more" returns a list of those items with deeplinks (no ack mutation).
	// Falls through to normal routing when the message isn't a recognised
	// keyword OR no recent voice surface exists — so a bare "done" stays
	// a valid conversational reply to vault-chat. ADR-003 reply-ack
	// semantics: done/skip = permanent ack; later = 4h cooldown then
	// re-eligible.
	const trimmedLower = workingBody.trim().toLowerCase();
	if (trimmedLower === 'done' || trimmedLower === 'skip' || trimmedLower === 'later') {
		const method = `reply-${trimmedLower}` as ReplyAckMethod;
		const updated = applyReplyAck(method);
		if (updated > 0) {
			const verb =
				method === 'reply-done'
					? 'Marked as done'
					: method === 'reply-skip'
						? 'Skipped'
						: 'Snoozed for 4 hours';
			const noun = updated === 1 ? 'voice-queue item' : `${updated} voice-queue items`;
			return json({ ok: true, action: 'reply', text: `${verb}: ${noun}.` });
		}
		// No recent voice surface → user is just saying "done" / "skip" /
		// "later" in conversation. Fall through to vault-chat below.
	}

	// ADR-009 Phase 6 — `/wrong` flags the most recent confirmed dispatch
	// on this conversation as wrong-agent. Triggers the falsifier (any
	// wrong dispatch in 14 days kills the branch) + fires a Telegram alert
	// so the user has a paper trail when picking the winner in Phase 7.
	if (trimmedLower === '/wrong' || trimmedLower === 'wrong agent' || trimmedLower === 'wrong dispatch') {
		const flagResult = flagWrongDispatch(conversationKey);
		if (!flagResult.flagged) {
			return json({
				ok: true,
				action: 'reply',
				text: "Nothing to flag — no recent confirmed dispatch on this conversation.",
			});
		}
		void notifyWrongDispatch({
			branchName: flagResult.modelBranch ?? '(unknown)',
			agentId: flagResult.agentId ?? '(unknown)',
			conversationKey,
			task: flagResult.task ?? '',
		});
		return json({
			ok: true,
			action: 'reply',
			text: `Flagged dispatch #${flagResult.historyId} (${flagResult.agentId}, branch ${flagResult.modelBranch ?? 'unknown'}) as wrong-agent. Logged for the A/B falsifier.`,
		});
	}
	if (trimmedLower === 'more') {
		const recent = getRecentVoiceSurface();
		if (recent.length > 0) {
			const publicUrl = (process.env.SOUL_HUB_PUBLIC_URL ?? '').replace(/\/$/, '');
			const engine = getVaultEngine();
			const lines: string[] = ['Recent voice items:'];
			for (let i = 0; i < recent.length; i++) {
				const r = recent[i];
				const note = engine?.getNote(r.notePath);
				const summary =
					(typeof note?.meta?.voice_summary === 'string' ? note.meta.voice_summary : null) ??
					note?.title ??
					r.notePath;
				lines.push(`${i + 1}. ${summary}`);
				if (publicUrl) {
					lines.push(`   ${publicUrl}/vault?note=${encodeURIComponent(r.notePath)}`);
				} else {
					lines.push(`   ${r.notePath}`);
				}
			}
			lines.push("\n(reply 'done' / 'skip' / 'later' to ack)");
			return json({ ok: true, action: 'reply', text: lines.join('\n') });
		}
		// No recent surface → fall through to vault-chat (treat "more" as
		// a conversational word).
	}

	// Same intercept chain as in-process dispatch.ts — slash → router →
	// chat. `maybeApplyRouter` is a no-op when `intentMap.default.dynamic`
	// is off (the default), preserving legacy behaviour for users who
	// haven't opted in.
	const baseIntent = resolveIntent(workingBody, cfg.intentMap);
	const intent = await maybeApplyRouter(baseIntent, cfg.intentMap, conversationKey);

	if (intent.route === 'unknown' || intent.route === 'help') {
		return json({ ok: true, action: 'help', text: helpReply(cfg.intentMap) });
	}

	try {
		// vault-chat wants a placeholder when the user just sent `/<route>` with
		// no body; brain commands handle empty natively. Keep both shapes in
		// scope and pick the right one per branch.
		const userText = intent.body || '(empty message)';
		const brainText = intent.body;

		let replyText: string;
		// WhatsApp ADR-005 + ADR-006 — orchestrator slot. Fires only on the
		// freeform vault-chat fallthrough, no media. Slash commands handled
		// upstream by resolveIntent. ADR-006 introduces the 6-action model
		// with a propose-confirm step before any heavy dispatch.
		if (intent.route === 'vault-chat' && !envelope.media) {
			// Phase 1.5a — `cancel` / `stop` short-circuits when ANY runs
			// are active OR a proposal is pending. Cancels every active
			// run on the JID and drops any pending proposal so the user
			// gets a clean slate.
			const lower = workingBody.trim().toLowerCase();
			if (lower === 'cancel' || lower === 'stop') {
				const active = listActiveOrchestratorRuns(envelope.chatJid);
				const hadPending = !!getPendingProposal(conversationKey);
				if (hadPending) resolvePendingProposal(conversationKey, 'cancelled');
				if (active.length > 0) {
					const cancelled = cancelOrchestratorRuns(envelope.chatJid);
					const text =
						cancelled.length === 1
							? `🛑 Cancelled *${cancelled[0].agentId}*.`
							: `🛑 Cancelled ${cancelled.length} runs: ${cancelled.map((r) => `*${r.agentId}*`).join(', ')}.`;
					return json({ ok: true, action: 'reply', text });
				}
				if (hadPending) {
					return json({ ok: true, action: 'reply', text: '🛑 Dropped the pending proposal.' });
				}
				return json({ ok: true, action: 'reply', text: 'Nothing to cancel.' });
			}

			// Explicit-reset regex. Catches softer reset signals than the
			// `cancel`/`stop` exact match above: "never mind", "nvm", "forget
			// it/that", "start over/fresh/again", "scratch that", "scrap
			// that". Drops any pending proposal (resolution: decline). Distinct
			// from cancel/stop above which ALSO kills active runs — these
			// phrases are gentler and shouldn't preempt a long-running agent.
			const RESET_RE = /^(?:never\s*mind|nvm|forget\s+(?:it|that)|start\s+(?:over|fresh|again)|scratch\s+that|scrap\s+that)\.?$/i;
			if (RESET_RE.test(workingBody.trim())) {
				const turnNow = Date.now();
				const hadPending = !!getPendingProposal(conversationKey);
				if (hadPending) resolvePendingProposal(conversationKey, 'decline');
				saveTurn(conversationKey, 'user', workingBody, turnNow);
				const text = hadPending
					? 'Got it — dropped that. Fresh start. What would you like to do?'
					: 'Fresh start. What would you like to do?';
				saveTurn(conversationKey, 'assistant', text, turnNow + 1);
				return json({ ok: true, action: 'reply', text });
			}

			// ADR-006 — pending-proposal interception. Runs BEFORE the
			// classifier. If a proposal is alive on this conversation, the
			// next message is read as a confirm/decline/switch-to-web/
			// unrelated reply. "Unrelated" drops the proposal and falls
			// through to normal classification (the user moved on).
			//
			// ADR-007 Gap 2 — expired-but-within-grace proposals (24h TTL +
			// 6h grace) are surfaced with `expired: true`. We send a one-off
			// "your proposal expired Xm ago" prompt and accept a fresh
			// confirm; anything else drops the row and falls through.
			const pending = getPendingProposal(conversationKey);
			if (pending?.expired) {
				const turnNow = Date.now();
				const replyKind = classifyProposalReply(workingBody);

				if (replyKind === 'confirm') {
					// User confirmed late — execute via the same path as the
					// fresh-confirm branch below. Resolve the proposal as
					// confirm so proposal_history's audit trail stays in sync
					// with the live row deletion.
					resolvePendingProposal(conversationKey, 'confirm');
					const capacity = checkDispatchCapacity(envelope.chatJid);
					if (!capacity.ok) {
						saveTurn(conversationKey, 'user', workingBody, turnNow);
						const rejection = formatCapacityRejection(capacity);
						saveTurn(conversationKey, 'assistant', rejection, turnNow + 1);
						return json({ ok: true, action: 'reply', text: rejection });
					}

					const ackText = `On it — running *${pending.agentId}* (revived from your earlier proposal). I'll send the summary here when it's ready (reply *cancel* to stop).`;
					let progressMessageId: string | undefined;
					try {
						const sendResult = await workerSendForOrchestrator(cfg.worker, {
							to: envelope.chatJid,
							text: ackText,
						});
						if (sendResult.ok && sendResult.messageId) {
							progressMessageId = sendResult.messageId;
						}
					} catch (err) {
						console.warn(
							`[orchestrator] revive-ack send failed (${(err as Error).message}); continuing without it`,
						);
					}
					saveTurn(conversationKey, 'user', workingBody, turnNow);
					const ctxConfirmed = getConversationContext(conversationKey, {
						jid: envelope.chatJid,
					});
					const agentContext = buildAgentContextBrief(ctxConfirmed);
					orchestratorDispatch({
						jid: envelope.chatJid,
						agentId: pending.agentId,
						task: pending.task,
						sourceMessage: workingBody,
						worker: cfg.worker,
						progressMessageId,
						conversationKey,
						agentContext,
					});
					return json({ ok: true, action: 'drop' });
				}

				// Anything else on an expired proposal — show the grace
				// prompt and clear the row so the next message classifies
				// fresh. This is the user-visible difference vs the silent
				// pre-ADR-007 drop.
				resolvePendingProposal(conversationKey, 'expired');
				saveTurn(conversationKey, 'user', workingBody, turnNow);
				const text = formatExpiredPrompt(pending);
				saveTurn(conversationKey, 'assistant', text, turnNow + 1);
				return json({ ok: true, action: 'reply', text });
			}

			if (pending) {
				const turnNow = Date.now();
				const replyKind = classifyProposalReply(workingBody);

				if (replyKind === 'confirm') {
					// Execute the stored proposal — same path as direct dispatch.
					// Resolve the proposal as `confirm` so the audit row updates
					// alongside the live `pending_proposals` delete.
					resolvePendingProposal(conversationKey, 'confirm');
					const capacity = checkDispatchCapacity(envelope.chatJid);
					if (!capacity.ok) {
						saveTurn(conversationKey, 'user', workingBody, turnNow);
						const rejection = formatCapacityRejection(capacity);
						saveTurn(conversationKey, 'assistant', rejection, turnNow + 1);
						return json({ ok: true, action: 'reply', text: rejection });
					}

					const ackText = `On it — running *${pending.agentId}*. I'll send the summary here when it's ready (reply *cancel* to stop).`;
					let progressMessageId: string | undefined;
					try {
						const sendResult = await workerSendForOrchestrator(cfg.worker, {
							to: envelope.chatJid,
							text: ackText,
						});
						if (sendResult.ok && sendResult.messageId) {
							progressMessageId = sendResult.messageId;
						}
					} catch (err) {
						console.warn(
							`[orchestrator] confirm-ack send failed (${(err as Error).message}); continuing without it`,
						);
					}
					saveTurn(conversationKey, 'user', workingBody, turnNow);
					const ctxConfirmed = getConversationContext(conversationKey, {
						jid: envelope.chatJid,
					});
					const agentContext = buildAgentContextBrief(ctxConfirmed);
					orchestratorDispatch({
						jid: envelope.chatJid,
						agentId: pending.agentId,
						task: pending.task,
						sourceMessage: workingBody,
						worker: cfg.worker,
						progressMessageId,
						conversationKey,
						agentContext,
					});
					return json({ ok: true, action: 'drop' });
				}

				if (replyKind === 'decline') {
					resolvePendingProposal(conversationKey, 'decline');
					saveTurn(conversationKey, 'user', workingBody, turnNow);
					const text = 'Got it — dropped that. What would you like instead?';
					saveTurn(conversationKey, 'assistant', text, turnNow + 1);
					return json({ ok: true, action: 'reply', text });
				}

				if (replyKind === 'switch-to-web') {
					// User wants the quick web-search alternative on the same
					// topic. We use the proposal's label as the search query
					// (it's a one-line description of what they wanted).
					resolvePendingProposal(conversationKey, 'switch-to-web');
					saveTurn(conversationKey, 'user', workingBody, turnNow);
					try {
						const r = await dispatchWebSearch(pending.label);
						const text = formatWebSearchForChat(r);
						saveTurn(conversationKey, 'assistant', text, turnNow + 1);
						return json({ ok: true, action: 'reply', text });
					} catch (err) {
						const text = `Couldn't run a web search: ${(err as Error).message}`;
						saveTurn(conversationKey, 'assistant', text, turnNow + 1);
						return json({ ok: true, action: 'reply', text });
					}
				}

				// 'unrelated' — drop the proposal and fall through to normal
				// classification on the new message.
				resolvePendingProposal(conversationKey, 'unrelated');
			}

			// ADR-007 Gap 4 — re-confirm guard. Catches duplicate "yes" hits
			// from poor connectivity or impatience: first confirm consumed
			// the proposal + fired dispatch, second one would otherwise be
			// classified as a chat ack with a confusing reply. If a recent
			// (<30s) orchestrator run is alive on this JID and the message
			// is a strict-confirm token, surface the active run instead of
			// re-classifying.
			const stripped = workingBody.trim().toLowerCase();
			if (/^(yes|y|go|ok|👍|✅)\.?$/.test(stripped)) {
				const recent = listActiveOrchestratorRuns(envelope.chatJid).filter(
					(r) => Date.now() - r.startedAt < 30_000,
				);
				if (recent.length > 0) {
					const turnNow = Date.now();
					saveTurn(conversationKey, 'user', workingBody, turnNow);
					const text = `Already on it — *${recent[0].agentId}* is running.`;
					saveTurn(conversationKey, 'assistant', text, turnNow + 1);
					return json({ ok: true, action: 'reply', text });
				}
			}

			// Load unified conversation context BEFORE deciding so the
			// orchestrator (and any agent it dispatches) sees the last few
			// turns + recent agent runs on this jid.
			const ctx = getConversationContext(conversationKey, { jid: envelope.chatJid });

			const decideStart = Date.now();
			const orch = await decideV2(workingBody, {
				history: ctx.history,
				conversationKey,
				senderNumber: envelope.senderNumber,
				account: cfg.account,
				timezone: cfg.heartbeat?.activeHours?.timezone ?? 'Asia/Dubai',
				imgConfig: {
					enabled: cfg.img.enabled,
					maxPerDay: cfg.img.maxPerDay,
					systemPromptPath: cfg.img.systemPromptPath,
					model: cfg.img.model,
				},
				youtubeConfig: {
					enabled: cfg.youtube.enabled,
					maxPerDay: cfg.youtube.maxPerDay,
					model: cfg.youtube.model,
				},
				tiktokConfig: {
					enabled: cfg.tiktok.enabled,
					maxPerDay: cfg.tiktok.maxPerDay,
					maxDurationSec: cfg.tiktok.maxDurationSec,
					model: cfg.tiktok.model,
				},
			});
			// Per ADR-023 Phase 1 + the WhatsApp orchestrator-v2 follow-up:
			// log the orchestrator's chosen sub-action (web-search, vault-chat,
			// dispatch, image, proposal, reply) alongside the routeFreeForm row
			// already written upstream. A single message can produce TWO
			// intent_log rows — one router decision (brain-find/recent/
			// vault-chat) and one orchestrator decision (its sub-action). The
			// future analyst infers the layer from picked_route values: only
			// orchestrator outputs include actions like web-search / dispatch /
			// image. fellThrough → vault-chat fallback row written below.
			if (!orch.fellThrough) {
				writeIntentDecision({
					ts: Date.now(),
					conversationKey,
					rawMessage: workingBody,
					normalizedSignature: normalizeSignature(workingBody),
					pickedRoute: orch.decision.action,
					source: 'llm',
					confidence: orch.decision.confidence,
					latencyMs: Date.now() - decideStart,
				});
			} else {
				writeIntentDecision({
					ts: Date.now(),
					conversationKey,
					rawMessage: workingBody,
					normalizedSignature: normalizeSignature(workingBody),
					pickedRoute: 'vault-chat',
					source: 'fallback',
					latencyMs: Date.now() - decideStart,
				});
			}

			if (!orch.fellThrough && orch.v2Output) {
				const out = orch.v2Output;
				const decision = orch.decision;
				const turnNow = Date.now();
				saveTurn(conversationKey, 'user', workingBody, turnNow);
				// Compact one-line decision log used by the operations
				// dashboard's "recent decisions" view + as a debug breadcrumb
				// when a real-world chat misroutes.
				console.log(
					`[orchestrator] v2 action=${decision.action} v2Output=${out.kind} confidence=${decision.confidence.toFixed(2)}${decision.agent ? ` agent=${decision.agent}` : ''}`,
				);
				if (out.kind === 'image') {
					saveTurn(
						conversationKey,
						'assistant',
						`[image] ${out.imagePrompt.slice(0, 120)}`,
						turnNow + 1,
					);
					return json({
						ok: true,
						action: 'reply',
						attachPath: out.attachPath,
						kind: 'image',
						caption: out.caption,
					});
				}
				if (out.kind === 'dispatch') {
					// Confirmed agent dispatch: capacity gate → worker ack
					// (capture messageId for progress edits) → fire-and-forget
					// `runInBackground` with `agentContext` from the
					// conversation context → return `drop` so the worker
					// doesn't double-respond.
					const capacity = checkDispatchCapacity(envelope.chatJid);
					if (!capacity.ok) {
						const rejection = formatCapacityRejection(capacity);
						saveTurn(conversationKey, 'assistant', rejection, turnNow + 1);
						return json({ ok: true, action: 'reply', text: rejection });
					}
					const ackText = `On it — running *${out.agentId}*. I'll send the summary here when it's ready (reply *cancel* to stop).`;
					let progressMessageId: string | undefined;
					try {
						const sendResult = await workerSendForOrchestrator(cfg.worker, {
							to: envelope.chatJid,
							text: ackText,
						});
						if (sendResult.ok && sendResult.messageId) {
							progressMessageId = sendResult.messageId;
						}
					} catch (err) {
						console.warn(
							`[orchestrator-v2] initial ack send failed (${(err as Error).message}); continuing without it`,
						);
					}
					const agentContext = buildAgentContextBrief(ctx);
					orchestratorDispatch({
						jid: envelope.chatJid,
						agentId: out.agentId,
						task: out.task,
						sourceMessage: workingBody,
						worker: cfg.worker,
						progressMessageId,
						conversationKey,
						agentContext,
					});
					return json({ ok: true, action: 'drop' });
				}
				// `text` / `proposal` / `error` — all carry `out.text` as the
				// pre-formatted user-facing string.
				saveTurn(conversationKey, 'assistant', out.text, turnNow + 1);
				return json({ ok: true, action: 'reply', text: out.text });
			}

			// No usable v2 output (timeout, model abstain, etc.) — fall through
			// to vault-chat below so the user gets *something*.
			replyText = '';
			if (orch.note) {
				console.warn(`[orchestrator] fell through: ${orch.note}`);
			}
		} else {
			replyText = '';
		}

		if (intent.route === 'vault-chat' && !replyText) {
			// Multimodal pass-through — when the message has image/video/
			// document attached, hand the bytes to vault-chat. Reuse the
			// already-decoded image buffer if we cached it at the top of
			// this handler; only decode here for non-image modalities
			// (which we don't auto-cache).
			let chatMedia: { buffer: Buffer; mimetype: string; kind: MediaPayload['kind'] } | undefined;
			if (inboundImageBuffer && inboundImageMime && envelope.media?.kind === 'image') {
				chatMedia = { buffer: inboundImageBuffer, mimetype: inboundImageMime, kind: 'image' };
			} else if (
				body.mediaBase64 &&
				envelope.media &&
				envelope.media.kind !== 'voice' &&
				envelope.media.kind !== 'sticker'
			) {
				try {
					chatMedia = {
						buffer: Buffer.from(body.mediaBase64, 'base64'),
						mimetype: envelope.media.mimetype,
						kind: envelope.media.kind,
					};
				} catch (err) {
					console.warn(`[_inbound] mediaBase64 decode for vault-chat failed: ${(err as Error).message}`);
				}
			}
			// Per ADR-022 Layer B (worker-mode parallel of dispatch.ts): send a
			// placeholder bubble via workerSend, capture the messageId, run the
			// slow LLM call, then edit the bubble in place. Return action='drop'
			// when the edit lands so the worker doesn't double-send the answer
			// as a fresh message. If anything in the placeholder/edit chain
			// fails, fall through to the normal action='reply' path so the
			// user always gets the answer.
			const placeholderText = placeholderTextForRoute('vault-chat', {
				isFocusQuery: isFocusQuery(userText),
				hasMedia: chatMedia !== undefined,
			});
			let placeholderId: string | undefined;
			try {
				const sendPlaceholder = await workerSendForOrchestrator(cfg.worker, {
					to: envelope.chatJid,
					text: placeholderText,
				});
				if (sendPlaceholder.ok && sendPlaceholder.messageId) {
					placeholderId = sendPlaceholder.messageId;
				}
			} catch (err) {
				console.warn(
					`[_inbound] vault-chat placeholder send failed (${(err as Error).message}); falling back to plain reply`,
				);
			}

			const result = await dispatchVaultChat(userText, conversationKey, chatMedia);
			replyText = result.text || '(no reply)';

			// Edit-in-place path. Baileys edit takes one text payload; if the
			// reply is too long for a single message, this returns an error
			// and we fall through to the normal chunked sendText path (the
			// placeholder bubble lingers as cosmetic noise — acceptable
			// trade-off for the v0 simplicity).
			if (placeholderId && replyText && replyText !== '(no reply)') {
				try {
					const edit = await workerSendForOrchestrator(cfg.worker, {
						to: envelope.chatJid,
						text: replyText,
						editId: placeholderId,
					});
					if (edit.ok) {
						return json({ ok: true, action: 'drop' });
					}
					console.warn(
						`[_inbound] vault-chat edit failed (${edit.error ?? 'unknown'}); falling back to plain reply`,
					);
				} catch (err) {
					console.warn(
						`[_inbound] vault-chat edit threw (${(err as Error).message}); falling back to plain reply`,
					);
				}
			}
		} else if (intent.route === 'brain-save') {
			// Worker-mode binary plumbing: the worker piggybacks media bytes
			// as base64 in `body.mediaBase64` (Slice 0). Decode here and pass
			// a Buffer to brain.save. All four media kinds participate —
			// voice gets archived alongside its transcript (transcript is
			// already in `workingBody`); image/video/document also fire a
			// single Gemini Flash extraction inside save.ts.
			let buffer: Buffer | undefined;
			let mimetype: string | undefined;
			let mediaKind: MediaPayload['kind'] | undefined;
			if (inboundImageBuffer && inboundImageMime && envelope.media?.kind === 'image') {
				// Reuse the already-decoded image; saves a redundant Buffer.from.
				buffer = inboundImageBuffer;
				mimetype = inboundImageMime;
				mediaKind = 'image';
			} else if (body.mediaBase64 && envelope.media) {
				try {
					buffer = Buffer.from(body.mediaBase64, 'base64');
					mimetype = envelope.media.mimetype;
					mediaKind = envelope.media.kind;
				} catch (err) {
					return json({
						ok: true,
						action: 'reply',
						text: `Couldn't decode the ${envelope.media.kind} bytes for /save: ${(err as Error).message}`,
					});
				}
			}
			// Slice 6 — `/img` cache fallback. When `/save` arrives without
			// fresh attachment bytes, fall back to the most recent generated
			// image for this conversation. Real attachments win; cache is a
			// pure fallback.
			const cachedImage = !buffer ? getLastImage(conversationKey) : undefined;
			const saveResult = await dispatchBrainSave({
				envelope,
				workingBody: brainText,
				mediaBuffer: buffer,
				mimetype,
				mediaKind,
				cachedImage: cachedImage
					? { buffer: cachedImage.buffer, mimetype: cachedImage.mimetype, prompt: cachedImage.prompt }
					: undefined,
			});
			replyText = saveResult.text;
		} else if (intent.route === 'img') {
			// Slice 6 — `/img` via worker mode. Generate or edit, write to
			// disk, return as `attachPath` so the worker reads + sends. Cache
			// + counter live in the main app process so they're shared with
			// any in-process flows.
			const imgCfg = cfg.img;
			if (!imgCfg.enabled) {
				return json({
					ok: true,
					action: 'reply',
					text: '`/img` is disabled in settings. Toggle it on under WhatsApp → Image generation.',
				});
			}
			const tzForDay = cfg.heartbeat?.activeHours?.timezone ?? 'Asia/Dubai';
			const today = ymdInTimezone(tzForDay);
			const count = getImgCount(envelope.senderNumber, today);
			if (count >= imgCfg.maxPerDay) {
				return json({
					ok: true,
					action: 'reply',
					text: `You've hit today's image budget (${imgCfg.maxPerDay}/day) — resets midnight ${tzForDay}.`,
				});
			}
			// Three sources of input image (mirroring dispatch.ts):
			//   1. Image already cached at the top of this handler — reuse
			//      its decoded buffer to skip a second decode.
			//   2. Non-image attachment (video/document) — decode inline.
			//   3. User's last inbound image from the cache (Slice 6
			//      follow-up) so "[photo] then `/img <edit>`" works.
			let inputImages: { buffer: Buffer; mimetype: string }[] | undefined;
			if (inboundImageBuffer && inboundImageMime) {
				inputImages = [{ buffer: inboundImageBuffer, mimetype: inboundImageMime }];
			} else if (
				body.mediaBase64 &&
				envelope.media &&
				envelope.media.kind !== 'voice' &&
				envelope.media.kind !== 'sticker' &&
				envelope.media.kind !== 'image'
			) {
				try {
					inputImages = [
						{
							buffer: Buffer.from(body.mediaBase64, 'base64'),
							mimetype: envelope.media.mimetype,
						},
					];
				} catch (err) {
					return json({
						ok: true,
						action: 'reply',
						text: `Couldn't decode the ${envelope.media.kind} bytes for /img: ${(err as Error).message}`,
					});
				}
			} else {
				const cachedUser = getLastUserImage(conversationKey);
				if (cachedUser) {
					inputImages = [{ buffer: cachedUser.buffer, mimetype: cachedUser.mimetype }];
				}
			}
			const imgResult = await dispatchImg({
				prompt: brainText,
				conversationKey,
				account: cfg.account,
				inputImages,
				systemPromptPath: imgCfg.systemPromptPath,
				model: imgCfg.model,
			});
			if (imgResult.error) {
				return json({ ok: true, action: 'reply', text: imgResult.error });
			}
			incrementImgCount(envelope.senderNumber, today);
			rememberLastImage(conversationKey, {
				buffer: imgResult.buffer,
				mimetype: imgResult.mimetype,
				prompt: imgResult.prompt,
			});
			return json({
				ok: true,
				action: 'reply',
				attachPath: imgResult.path,
				kind: 'image',
				caption: imgResult.caption,
			});
		} else if (intent.route === 'brain-find') {
			replyText = (await dispatchBrainFind(brainText)).text;
		} else if (intent.route === 'brain-recent') {
			replyText = (await dispatchBrainRecent()).text;
		} else {
			const result = await dispatchRoute(intent.route, {
				messages: [{ role: 'user', content: userText }],
				maxOutputTokens: 800,
			});
			replyText = result.text || '(no reply)';
		}

		// Slice 5 — fire-and-forget commitment extraction. Mirrors dispatch.ts;
		// runs after we've decided what to send back so it can never delay
		// the worker's reply. Gated inside the helper (off by default).
		extractCommitmentsAsync({
			channel: 'whatsapp',
			target: envelope.senderNumber,
			userText,
			agentReply: replyText,
			sourceMsgId: envelope.messageId || null,
		});

		return json({ ok: true, action: 'reply', text: replyText });
	} catch (err) {
		const message =
			err instanceof RouteNotFoundError
				? `Route "${intent.route}" is not configured. Edit settings.json or remove this command from intentMap.`
				: `Sorry, I hit an error: ${(err as Error).message}`;
		return json({ ok: true, action: 'reply', text: message });
	}
};
