/** Inbound dispatcher — wires the WhatsApp envelope through access
 *  control → optional voice-note transcription → intent resolution →
 *  routes layer → outbound reply. Lives separate from `connection.ts`
 *  so the lifecycle code stays focused on the socket and so the
 *  dispatcher can be unit-tested without spawning Baileys. */

import type { proto } from '@whiskeysockets/baileys';
import { dispatchRoute, RouteNotFoundError } from '../../routes/index.js';
import { dispatchVaultChat } from '../../vault-chat/index.js';
import { checkAccess } from './access-control.js';
import { resolveIntent } from './intent.js';
import { getSocket } from './connection.js';
import { editText, reactTo, sendMedia, sendText, sendTypingIndicator, chunkText } from './outbound.js';
import { startTypingLoop } from '../_shared/typing.js';
import { isFocusQuery, placeholderTextForRoute } from '../_shared/placeholder.js';
import { downloadMedia, saveMediaToDisk } from './media.js';
import { transcribeVoiceNote } from './transcribe.js';
import { resolveSenderLid } from './lid-resolve.js';
import { isResetCommand, resetConversation } from '../../vault-chat/history.js';
import {
	isHeartbeatMetaCommand,
	handleHeartbeatMetaCommand,
	isCommitmentsMetaCommand,
	handleCommitmentsMetaCommand,
} from './heartbeat-commands.js';
import { extractCommitmentsAsync } from './commitments-extractor.js';
import { dispatchBrainSave, dispatchBrainFind, dispatchBrainRecent } from '../../brain/index.js';
import { dispatchImg, rememberLastImage, getLastImage, rememberLastUserImage, getLastUserImage } from '../../img/index.js';
import {
	getImgCount,
	incrementImgCount,
	ymdInTimezone,
} from './heartbeat-state.js';
import { maybeApplyRouter } from './router.js';
import type { InboundEnvelope, MediaPayload, WhatsAppChannelConfig } from './types.js';

const HELP_PREFIX = 'I do not recognise that command. Available:';

function helpReply(intentMap: WhatsAppChannelConfig['intentMap']): string {
	const lines: string[] = [HELP_PREFIX];
	for (const [token, mapping] of Object.entries(intentMap)) {
		if (token === 'default') continue;
		const description = mapping.description ? ` — ${mapping.description}` : '';
		lines.push(`  ${token} → ${mapping.route}${description}`);
	}
	lines.push('');
	lines.push('Free-form messages route to `default`.');
	lines.push('Voice notes are auto-transcribed when transcription is enabled.');
	return lines.join('\n');
}

/** Voice-note pipeline: size-check → download → transcribe → return text
 *  AND the underlying buffer so a downstream `/save` can archive the audio
 *  without re-downloading. On any failure the dispatcher surfaces a
 *  friendly reply and the routes-layer call is skipped. */
async function transcribeIfVoice(
	envelope: InboundEnvelope,
	rawMessage: proto.IWebMessageInfo,
	config: WhatsAppChannelConfig,
): Promise<{ text?: string; buffer?: Buffer; error?: string }> {
	const media = envelope.media;
	if (!media || media.kind !== 'voice') return { text: undefined };
	if (!config.delivery.transcribeVoiceNotes) return { text: undefined };

	const maxBytes = config.delivery.maxMediaSizeMB * 1024 * 1024;
	if (media.fileLength && media.fileLength > maxBytes) {
		return {
			error: `Voice note exceeds ${config.delivery.maxMediaSizeMB}MB cap (was ${(media.fileLength / 1024 / 1024).toFixed(1)}MB) — not transcribing.`,
		};
	}

	let buffer: Buffer;
	try {
		buffer = await downloadMedia(rawMessage);
	} catch (err) {
		return { error: `Couldn't download voice note: ${(err as Error).message}` };
	}

	// Best-effort archival — failure here doesn't block transcription.
	try {
		saveMediaToDisk({
			account: config.account,
			messageId: envelope.messageId || `inbound-${Date.now()}`,
			payload: media,
			buffer,
		});
	} catch {
		/* archival is optional */
	}

	try {
		const result = await transcribeVoiceNote({
			audio: buffer,
			mimetype: media.mimetype,
			providerRef: config.delivery.transcribeProvider,
		});
		return { text: result.text, buffer };
	} catch (err) {
		return { error: `Couldn't transcribe voice note: ${(err as Error).message}` };
	}
}

export async function dispatchInbound(
	rawEnvelope: InboundEnvelope,
	rawMessage: proto.IWebMessageInfo,
	config: WhatsAppChannelConfig,
): Promise<void> {
	const sock = getSocket();
	if (!sock) return; // disconnected — nothing to reply with

	// Promote @lid sender JIDs to PN form before access control sees them.
	// Mirrors the worker's resolver step so allowlist checks behave the
	// same way regardless of which mode (in-process vs worker) is active.
	const envelope = await resolveSenderLid(rawEnvelope, sock);

	const access = checkAccess(envelope, config.access);
	if (!access.allow) {
		// Silently drop. Logging happens at higher level if the user wants it.
		return;
	}

	// Ack reaction first so the sender sees the message was picked up,
	// even if transcription / routing takes a few seconds.
	if (config.delivery.ackEmoji) {
		await reactTo(sock, envelope.chatJid, envelope.messageId, config.delivery.ackEmoji);
	}

	// Voice-note transcription folds into `body` so the rest of the
	// pipeline (intent → routes) doesn't care about the original modality.
	let workingBody = envelope.body;
	const transcription = await transcribeIfVoice(envelope, rawMessage, config);
	if (transcription.error) {
		await sendText(sock, envelope.chatJid, transcription.error, config.delivery);
		return;
	}
	if (transcription.text !== undefined) {
		workingBody = transcription.text;
	}

	// Conversation key — groups share one thread, DMs thread per-sender.
	// Computed early because both the inbound-image cache (Slice 6
	// follow-up) and the meta-command branches need it.
	const conversationKey = envelope.isGroup ? envelope.chatJid : envelope.senderNumber;

	// Inbound image cache (Slice 6 follow-up): when the user sends an
	// image — caption or no caption — download it once and stash a copy
	// keyed by `conversationKey`. Subsequent `/img <prompt>` (no fresh
	// attachment) falls back to this cache so the natural WhatsApp flow
	// "[photo] then `/img make it night`" works without forwarding the
	// image back. Same TTL/LRU as the bot-output cache. We hold the
	// buffer in `inboundImageBuffer` so the downstream branches reuse
	// it instead of paying a second `downloadMedia` call.
	let inboundImageBuffer: Buffer | undefined;
	let inboundImageMime: string | undefined;
	if (envelope.media?.kind === 'image') {
		try {
			inboundImageBuffer = await downloadMedia(rawMessage);
			inboundImageMime = envelope.media.mimetype;
			rememberLastUserImage(conversationKey, {
				buffer: inboundImageBuffer,
				mimetype: inboundImageMime,
			});
		} catch (err) {
			console.warn(`[whatsapp] inbound image cache: download failed: ${(err as Error).message}`);
			// Soft-fail. Downstream branches that need the buffer will
			// either re-download or surface their own error.
		}
	}

	// Non-voice media without a caption: acknowledge but don't try to
	// route empty text. (Captions on images/videos already populate `body`
	// via `extractText`, so those flow through normally.) The cache above
	// already ran, so a follow-up `/img` will pick this image up.
	if (envelope.media && envelope.media.kind !== 'voice' && !workingBody.trim()) {
		const hint =
			envelope.media.kind === 'image'
				? `I got your image. Tell me what you want to do with it — ask a question, describe it, send \`/img <how to edit>\` to edit it, or \`/save\` to capture it to the vault.`
				: `I got your ${envelope.media.kind}. Tell me what you want to do with it — ask a question, describe it, or send \`/save\` (as a follow-up message or as the caption next time) to capture it to the vault.`;
		await sendText(sock, envelope.chatJid, hint, config.delivery);
		return;
	}

	// Reset commands wipe per-key history and short-circuit before any
	// routing. Hoisted above `resolveIntent` because `/reset` etc. would
	// otherwise be treated as unknown intent-map tokens and trigger the
	// help reply instead of the reset path.
	if (isResetCommand(workingBody)) {
		const cleared = resetConversation(conversationKey);
		const replyText = cleared > 0
			? "Conversation reset. What's on your mind?"
			: 'Already a fresh slate.';
		await sendText(sock, envelope.chatJid, replyText, config.delivery);
		return;
	}

	// Heartbeat meta-commands (`/heartbeat`, `/mute`, `/resume`) mutate
	// settings.json and trigger schedule reload — they are not chat
	// content. Hoisted above `resolveIntent` for the same reason as `/reset`.
	if (isHeartbeatMetaCommand(workingBody)) {
		try {
			const reply = await handleHeartbeatMetaCommand(workingBody);
			await sendText(sock, envelope.chatJid, reply, config.delivery);
		} catch (err) {
			await sendText(
				sock,
				envelope.chatJid,
				`Heartbeat command failed: ${(err as Error).message}`,
				config.delivery,
			);
		}
		return;
	}

	// Slice 5 — `/commitments [list|dismiss <id>]`. Scoped to sender's number.
	if (isCommitmentsMetaCommand(workingBody)) {
		try {
			const reply = await handleCommitmentsMetaCommand(workingBody, envelope.senderNumber);
			await sendText(sock, envelope.chatJid, reply, config.delivery);
		} catch (err) {
			await sendText(
				sock,
				envelope.chatJid,
				`Commitments command failed: ${(err as Error).message}`,
				config.delivery,
			);
		}
		return;
	}

	// Resolve slash → route mapping first. `maybeApplyRouter` then rewrites
	// the route only when the message wasn't a slash command AND the user
	// has opted in via `intentMap.default.dynamic`. Order mirrors the
	// ADR-001 §3 intercept chain: reset → slash meta → activeWorkflow?
	// (Slice 4 placeholder) → router → vault-chat.
	// Per ADR-022 Layer A: start typing indicator before the router LLM
	// call so the user sees "Soul Hub is typing…" within ~100ms of their
	// message. Re-fires every 4s; stopped by `finally` below regardless of
	// outcome (early return, success, error). Decorative — failures inside
	// the indicator never block the reply path.
	const stopTyping = startTypingLoop(() => sendTypingIndicator(sock, envelope.chatJid));
	// Per ADR-022 Layer B: vault-chat sends a placeholder bubble before
	// the slow LLM call so we can edit it in place when the answer is
	// ready (one bubble per turn, instead of "thinking…" + "answer" as
	// two separate messages).
	let placeholderId: string | null = null;
	try {
	const baseIntent = resolveIntent(workingBody, config.intentMap);
	const intent = await maybeApplyRouter(baseIntent, config.intentMap, conversationKey);

	if (intent.route === 'unknown') {
		await sendText(sock, envelope.chatJid, helpReply(config.intentMap), config.delivery);
		return;
	}

	if (intent.route === 'help') {
		await sendText(sock, envelope.chatJid, helpReply(config.intentMap), config.delivery);
		return;
	}

	try {
		// vault-chat goes through the lexical orchestrator (ADR-004) so the
		// reply is grounded in the user's vault, not the model's own knowledge.
		// /save, /find, /recent are intercepted here too — they read/write the
		// vault directly rather than hitting the LLM (save still calls Flash
		// for multimodal extraction internally). All other intents fall
		// through to the routes layer.
		// `(empty message)` placeholder is a vault-chat convenience — gives the
		// LLM something to chew on. Brain commands handle empty bodies natively
		// (`/find` returns usage; `/save` with image-only caption is legit), so
		// they receive the raw `intent.body`.
		const userText = intent.body || '(empty message)';
		const brainText = intent.body;

		let replyText: string;
		if (intent.route === 'vault-chat') {
			// Multimodal pass-through — when the message has image/video/audio/
			// document attached, hand the bytes to vault-chat so the LLM can
			// actually see what the user sent. Voice already came through
			// `transcribeIfVoice` as text — no second pass needed.
			// Reuse the inbound image buffer when we already cached it at
			// the top of this function; download here only for non-image
			// modalities (video / document / audio).
			let chatMedia: { buffer: Buffer; mimetype: string; kind: MediaPayload['kind'] } | undefined;
			if (inboundImageBuffer && inboundImageMime && envelope.media?.kind === 'image') {
				chatMedia = { buffer: inboundImageBuffer, mimetype: inboundImageMime, kind: 'image' };
			} else if (envelope.media && envelope.media.kind !== 'voice' && envelope.media.kind !== 'sticker') {
				try {
					const buf = await downloadMedia(rawMessage);
					chatMedia = { buffer: buf, mimetype: envelope.media.mimetype, kind: envelope.media.kind };
				} catch (err) {
					console.warn(`[whatsapp] media download for vault-chat failed: ${(err as Error).message}`);
					// Fall through — chat still works on the caption alone.
				}
			}
			// Send placeholder bubble (ADR-022 Layer B). Captured messageId
			// is used after the dispatch returns to edit-in-place. Best-effort:
			// if the placeholder send fails, fall through to a normal sendText
			// at the end.
			const placeholderText = placeholderTextForRoute('vault-chat', {
				isFocusQuery: isFocusQuery(userText),
				hasMedia: chatMedia !== undefined,
			});
			const sentPlaceholder = await sendText(
				sock,
				envelope.chatJid,
				placeholderText,
				config.delivery,
			);
			if (sentPlaceholder.ok && sentPlaceholder.messageIds.length > 0) {
				placeholderId = sentPlaceholder.messageIds[0];
			}
			const result = await dispatchVaultChat(userText, conversationKey, chatMedia);
			replyText = result.text || '(no reply)';
		} else if (intent.route === 'brain-save') {
			// Voice — buffer was already fetched by `transcribeIfVoice` above
			// (transcript landed in `workingBody`). Reuse it instead of
			// re-downloading. Image/video/document — download here so save.ts
			// can run extraction + archive the asset.
			let buffer: Buffer | undefined;
			let mimetype: string | undefined;
			let mediaKind: MediaPayload['kind'] | undefined;
			if (envelope.media?.kind === 'voice' && transcription.buffer) {
				buffer = transcription.buffer;
				mimetype = envelope.media.mimetype;
				mediaKind = 'voice';
			} else if (inboundImageBuffer && inboundImageMime && envelope.media?.kind === 'image') {
				// Reuse the inbound-cached image rather than downloading twice.
				buffer = inboundImageBuffer;
				mimetype = inboundImageMime;
				mediaKind = 'image';
			} else if (envelope.media && envelope.media.kind !== 'sticker') {
				try {
					buffer = await downloadMedia(rawMessage);
					mimetype = envelope.media.mimetype;
					mediaKind = envelope.media.kind;
				} catch (err) {
					await sendText(
						sock,
						envelope.chatJid,
						`Couldn't fetch the ${envelope.media.kind} for /save: ${(err as Error).message}`,
						config.delivery,
					);
					return;
				}
			}
			// Slice 6 — `/img` cache fallback. When the user types `/save` with
			// no fresh attachment, fall back to the last `/img` output for
			// this conversation. A real attachment always wins (handled above).
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
			// Slice 6 — `/img` generates or edits an image. Daily cap gate
			// runs before any API call. Generated bytes go to chat as media
			// (not text); cached for `/save` follow-up; counter incremented
			// only on success so a retry after a crash isn't double-charged.
			const imgCfg = config.img;
			if (!imgCfg.enabled) {
				replyText = '`/img` is disabled in settings. Toggle it on under WhatsApp → Image generation.';
			} else {
				const tzForDay = config.heartbeat?.activeHours?.timezone ?? 'Asia/Dubai';
				const today = ymdInTimezone(tzForDay);
				const count = getImgCount(envelope.senderNumber, today);
				if (count >= imgCfg.maxPerDay) {
					replyText = `You've hit today's image budget (${imgCfg.maxPerDay}/day) — resets midnight ${tzForDay}.`;
				} else {
					// Editing branch — three sources of input image, in order:
					//   1. Fresh image on this message — already cached above
					//      as `inboundImageBuffer` so we avoid a second download.
					//   2. A non-image attachment (video / document) — those
					//      aren't auto-cached; download inline.
					//   3. The user's last inbound image in this conversation,
					//      from the cache. This makes "[photo] then `/img <edit>`"
					//      work without forwarding the image back to the bot.
					let inputImages: { buffer: Buffer; mimetype: string }[] | undefined;
					if (inboundImageBuffer && inboundImageMime) {
						inputImages = [{ buffer: inboundImageBuffer, mimetype: inboundImageMime }];
					} else if (
						envelope.media &&
						envelope.media.kind !== 'voice' &&
						envelope.media.kind !== 'sticker' &&
						envelope.media.kind !== 'image'
					) {
						try {
							const buf = await downloadMedia(rawMessage);
							inputImages = [{ buffer: buf, mimetype: envelope.media.mimetype }];
						} catch (err) {
							await sendText(
								sock,
								envelope.chatJid,
								`Couldn't fetch the ${envelope.media.kind} for /img: ${(err as Error).message}`,
								config.delivery,
							);
							return;
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
						account: config.account,
						inputImages,
						systemPromptPath: imgCfg.systemPromptPath,
						model: imgCfg.model,
					});
					if (imgResult.error) {
						replyText = imgResult.error;
					} else {
						const sendResult = await sendMedia(sock, envelope.chatJid, {
							kind: 'image',
							path: imgResult.path,
							mimetype: imgResult.mimetype,
							caption: imgResult.caption,
						});
						if (!sendResult.ok) {
							replyText = `Generated the image but couldn't send it: ${sendResult.error ?? 'unknown error'}`;
						} else {
							incrementImgCount(envelope.senderNumber, today);
							rememberLastImage(conversationKey, {
								buffer: imgResult.buffer,
								mimetype: imgResult.mimetype,
								prompt: imgResult.prompt,
							});
							// Skip the trailing `sendText` — we already delivered the
							// image. Skip commitment extraction too: an image isn't
							// useful conversational signal.
							return;
						}
					}
				}
			}
		} else if (intent.route === 'brain-find') {
			const findResult = await dispatchBrainFind(brainText);
			replyText = findResult.text;
		} else if (intent.route === 'brain-recent') {
			const recentResult = await dispatchBrainRecent();
			replyText = recentResult.text;
		} else {
			const result = await dispatchRoute(intent.route, {
				messages: [{ role: 'user', content: userText }],
				maxOutputTokens: 800,
			});
			replyText = result.text || '(no reply)';
		}
		// Stop the typing loop right before delivery — the response is about
		// to land, no need to keep firing the indicator.
		stopTyping();

		// Per ADR-022 Layer B: if a placeholder bubble is in flight, edit it
		// in place to the first chunk and send remaining chunks fresh. If
		// editText fails (rare — usually because the bubble was deleted or
		// the channel throttles edits), fall back to a fresh sendText so the
		// user still gets the reply. Bubble stays in chat as cosmetic noise
		// in that path; functional path is preserved.
		if (placeholderId !== null && replyText && replyText !== '(no reply)') {
			const chunks = chunkText(
				replyText,
				config.delivery.textChunkLimit,
				config.delivery.chunkMode,
			);
			if (chunks.length > 0) {
				const editResult = await editText(sock, envelope.chatJid, placeholderId, chunks[0]);
				if (editResult.ok) {
					for (let i = 1; i < chunks.length; i++) {
						try {
							await sock.sendMessage(envelope.chatJid, { text: chunks[i] });
						} catch {
							/* swallow — primary delivery already happened via the edit */
						}
					}
				} else {
					await sendText(sock, envelope.chatJid, replyText, config.delivery);
				}
			} else {
				await sendText(sock, envelope.chatJid, replyText, config.delivery);
			}
		} else {
			await sendText(sock, envelope.chatJid, replyText, config.delivery);
		}

		// Slice 5 — fire-and-forget extraction of inferred commitments. Off
		// by default; gated inside extractCommitmentsAsync. Runs after the
		// user already has the reply so it can never delay the chat.
		extractCommitmentsAsync({
			channel: 'whatsapp',
			target: envelope.senderNumber,
			userText,
			agentReply: replyText,
			sourceMsgId: envelope.messageId || null,
		});
	} catch (err) {
		const message = err instanceof RouteNotFoundError
			? `Route "${intent.route}" is not configured. Edit settings.json or remove this command from intentMap.`
			: `Sorry, I hit an error: ${(err as Error).message}`;
		// On error: edit the placeholder bubble (if any) to the error so the
		// chat doesn't accumulate a stale "🟡 …" bubble next to a fresh error
		// message. Fallback to fresh send if the edit itself fails.
		if (placeholderId !== null) {
			const ed = await editText(sock, envelope.chatJid, placeholderId, message);
			if (!ed.ok) {
				await sendText(sock, envelope.chatJid, message, config.delivery);
			}
		} else {
			await sendText(sock, envelope.chatJid, message, config.delivery);
		}
	}
	} finally {
		// Outer finally: covers all early returns (unknown, help, img return)
		// AND both branches of the inner try/catch. Ensures the typing loop
		// is always cleared, even if an unexpected error escapes.
		stopTyping();
	}
}
