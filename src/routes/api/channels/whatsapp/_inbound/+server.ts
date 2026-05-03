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
import { isResetCommand, resetConversation } from '$lib/vault-chat/history.js';
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
	getImgCount,
	incrementImgCount,
	ymdInTimezone,
} from '$lib/channels/whatsapp/heartbeat-state.js';
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

	// Same intercept chain as in-process dispatch.ts — slash → router →
	// chat. `maybeApplyRouter` is a no-op when `intentMap.default.dynamic`
	// is off (the default), preserving legacy behaviour for users who
	// haven't opted in.
	const baseIntent = resolveIntent(workingBody, cfg.intentMap);
	const intent = await maybeApplyRouter(baseIntent, cfg.intentMap);

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
		if (intent.route === 'vault-chat') {
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
			const result = await dispatchVaultChat(userText, conversationKey, chatMedia);
			replyText = result.text || '(no reply)';
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
