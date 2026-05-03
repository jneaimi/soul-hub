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
} from '$lib/channels/whatsapp/heartbeat-commands.js';

interface InboundBody {
	envelope: InboundEnvelope;
	transcript?: string;
}

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
		return json({ ok: true, action: 'reply', text: result.text || '(no reply)' });
	} catch (err) {
		const message =
			err instanceof RouteNotFoundError
				? `Route "${intent.route}" is not configured. Edit settings.json or remove this command from intentMap.`
				: `Sorry, I hit an error: ${(err as Error).message}`;
		return json({ ok: true, action: 'reply', text: message });
	}
};
