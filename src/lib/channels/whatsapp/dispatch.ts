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
import { reactTo, sendText } from './outbound.js';
import { downloadMedia, saveMediaToDisk } from './media.js';
import { transcribeVoiceNote } from './transcribe.js';
import { resolveSenderLid } from './lid-resolve.js';
import { isResetCommand, resetConversation } from '../../vault-chat/history.js';
import { isHeartbeatMetaCommand, handleHeartbeatMetaCommand } from './heartbeat-commands.js';
import type { InboundEnvelope, WhatsAppChannelConfig } from './types.js';

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

/** Voice-note pipeline: size-check → download → transcribe → return text.
 *  On any failure the dispatcher surfaces a friendly reply and the
 *  routes-layer call is skipped. */
async function transcribeIfVoice(
	envelope: InboundEnvelope,
	rawMessage: proto.IWebMessageInfo,
	config: WhatsAppChannelConfig,
): Promise<{ text?: string; error?: string }> {
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
		return { text: result.text };
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

	// Non-voice media without a caption: acknowledge but don't try to
	// route empty text. (Captions on images/videos already populate `body`
	// via `extractText`, so those flow through normally.)
	if (envelope.media && envelope.media.kind !== 'voice' && !workingBody.trim()) {
		await sendText(
			sock,
			envelope.chatJid,
			`I received your ${envelope.media.kind}, but I can only act on it with a caption or a follow-up message describing what to do.`,
			config.delivery,
		);
		return;
	}

	// Conversation key — groups share one thread, DMs thread per-sender.
	// Computed once so reset can use it before intent resolution (reset
	// is a meta-command, not a route).
	const conversationKey = envelope.isGroup ? envelope.chatJid : envelope.senderNumber;

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

	const intent = resolveIntent(workingBody, config.intentMap);

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
		// All other intents call the routes layer directly.
		const userText = intent.body || '(empty message)';

		const result = intent.route === 'vault-chat'
			? await dispatchVaultChat(userText, conversationKey)
			: await dispatchRoute(intent.route, {
					messages: [{ role: 'user', content: userText }],
					maxOutputTokens: 800,
				});
		await sendText(sock, envelope.chatJid, result.text || '(no reply)', config.delivery);
	} catch (err) {
		const message = err instanceof RouteNotFoundError
			? `Route "${intent.route}" is not configured. Edit settings.json or remove this command from intentMap.`
			: `Sorry, I hit an error: ${(err as Error).message}`;
		await sendText(sock, envelope.chatJid, message, config.delivery);
	}
}
