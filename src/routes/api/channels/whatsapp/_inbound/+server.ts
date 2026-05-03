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

	if (envelope.media && envelope.media.kind !== 'voice' && !workingBody.trim()) {
		return json({
			ok: true,
			action: 'reply',
			text: `I received your ${envelope.media.kind}, but I can only act on it with a caption or a follow-up message describing what to do.`,
		});
	}

	// Conversation key: groups share one thread across members; DMs thread
	// per-sender. Computed once up here so reset can use it before intent
	// resolution (reset is a meta-command, not a route).
	const conversationKey = envelope.isGroup ? envelope.chatJid : envelope.senderNumber;

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

	const intent = resolveIntent(workingBody, cfg.intentMap);

	if (intent.route === 'unknown' || intent.route === 'help') {
		return json({ ok: true, action: 'help', text: helpReply(cfg.intentMap) });
	}

	try {
		const userText = intent.body || '(empty message)';

		const result = intent.route === 'vault-chat'
			? await dispatchVaultChat(userText, conversationKey)
			: await dispatchRoute(intent.route, {
					messages: [{ role: 'user', content: userText }],
					maxOutputTokens: 800,
				});
		const replyText = result.text || '(no reply)';

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
