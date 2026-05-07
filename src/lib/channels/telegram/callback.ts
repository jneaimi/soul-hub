/** Inline-keyboard `callback_query` handler.
 *
 *  Telegram inline-keyboard buttons fire a `callback_query` with the
 *  button's `callback_data` payload. We use that as a synthetic chat
 *  message so the same proposal-resolution pipeline that handles a text
 *  reply ("yes" / "no" / "search") works for button taps too.
 *
 *  callback_data layout: `<verb>:<short_id>` where verb is one of
 *    confirm | decline | web
 *  and short_id is a base64url'd SHA-1 of the conversationKey, fitting
 *  inside Telegram's 64-byte callback_data cap and avoiding leaking the
 *  raw key (DM ids look like phone numbers when prefixed). The mapping
 *  is held in-process; restart-loss is acceptable because pending
 *  proposals expire on the same timescale as PM2 restarts. */

import { createHash } from 'node:crypto';
import { answerCallbackQuery, editMessageText } from './client.js';
import { sendText } from './outbound.js';
import { dispatchInbound, conversationKeyFor } from './dispatch.js';
import type {
	InboundEnvelope,
	InlineKeyboardMarkup,
	TelegramChannelConfig,
	TgCallbackQuery,
} from './types.js';

type Verb = 'confirm' | 'decline' | 'web';

interface PendingButtonRow {
	conversationKey: string;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

/** short_id → conversation key map. SHA-1 keeps us inside Telegram's
 *  64-byte callback_data cap. We could persist this to SQLite if a
 *  restart-survival need pops up; for now in-memory is fine. */
const pendingButtons = new Map<string, PendingButtonRow>();
const PENDING_TTL_MS = 60 * 60 * 1000; // 1h matches proposal grace

function shortIdFor(conversationKey: string): string {
	return createHash('sha1').update(conversationKey).digest('base64url').slice(0, 16);
}

export function buildProposalKeyboard(conversationKey: string): InlineKeyboardMarkup {
	const id = shortIdFor(conversationKey);
	return {
		inline_keyboard: [
			[
				{ text: '✅ Yes — run it', callback_data: `confirm:${id}` },
				{ text: '🌐 Web search', callback_data: `web:${id}` },
			],
			[{ text: '✗ Drop it', callback_data: `decline:${id}` }],
		],
	};
}

/** Stash the (conversationKey, chatJid, messageId) for a freshly-rendered
 *  proposal so the callback handler can resolve which conversation a
 *  button-tap belongs to. Older entries are GC'd lazily. */
export function rememberProposalButtons(
	conversationKey: string,
	chatJid: string,
	messageId: number,
): void {
	const id = shortIdFor(conversationKey);
	pendingButtons.set(id, {
		conversationKey,
		chatJid,
		messageId,
		createdAt: Date.now(),
	});
	// Lazy GC.
	const now = Date.now();
	for (const [k, v] of pendingButtons) {
		if (now - v.createdAt > PENDING_TTL_MS) pendingButtons.delete(k);
	}
}

function parseCallbackData(data: string): { verb: Verb; id: string } | null {
	const i = data.indexOf(':');
	if (i === -1) return null;
	const verb = data.slice(0, i);
	const id = data.slice(i + 1);
	if (verb !== 'confirm' && verb !== 'decline' && verb !== 'web') return null;
	if (!id) return null;
	return { verb, id };
}

const VERB_TO_REPLY: Record<Verb, string> = {
	confirm: 'yes',
	decline: 'no',
	web: 'search',
};

const VERB_TO_CONFIRMATION: Record<Verb, string> = {
	confirm: '✅ Running it.',
	decline: '✗ Dropped.',
	web: '🌐 Searching the web instead.',
};

/** Handle a `callback_query` Update. Resolves the button to its
 *  conversation, then re-enters the inbound dispatcher with a synthetic
 *  text message ("yes" / "no" / "search") so the proposal-confirmation
 *  pathway runs identically to a typed reply. */
export async function handleCallbackQuery(
	query: TgCallbackQuery,
	config: TelegramChannelConfig,
	account = 'personal',
): Promise<void> {
	const data = query.data ?? '';
	const parsed = parseCallbackData(data);
	if (!parsed) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Unknown action',
		});
		return;
	}

	const row = pendingButtons.get(parsed.id);
	if (!row) {
		// Stale or restarted — politely tell the user.
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Buttons expired — send a new message to retry.',
			show_alert: false,
		});
		return;
	}

	// Acknowledge the tap so Telegram clears the loading spinner. Telegram
	// requires a response within ~10s.
	await answerCallbackQuery({
		callback_query_id: query.id,
		text: VERB_TO_CONFIRMATION[parsed.verb],
	});

	// Edit the original message to strip buttons so a second tap can't
	// double-fire the proposal. Best-effort.
	try {
		await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: `${VERB_TO_CONFIRMATION[parsed.verb]}\n_(button tapped)_`,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow — buttons may already be gone */
	}

	pendingButtons.delete(parsed.id);

	// Synthesize a chat message and feed it through the same dispatcher
	// path a typed reply would take. The orchestrator-v2 already knows
	// how to interpret "yes"/"no"/"search" against a pending proposal.
	const synthetic: InboundEnvelope = {
		chatJid: row.chatJid,
		isGroup: row.chatJid.startsWith('-'),
		senderNumber: query.from.id ? String(query.from.id) : row.chatJid,
		botMentioned: false,
		body: VERB_TO_REPLY[parsed.verb],
		messageId: '',
		raw: {
			message_id: 0,
			chat: { id: Number(row.chatJid), type: 'private' },
			date: Math.floor(Date.now() / 1000),
			text: VERB_TO_REPLY[parsed.verb],
		},
	};

	// Sanity: the conversation key derived from this synthetic envelope
	// must match the original. If they diverge (group vs DM ambiguity) we
	// fall back to a friendly nudge.
	const expected = row.conversationKey;
	const derived = conversationKeyFor(synthetic);
	if (derived !== expected) {
		await sendText(
			row.chatJid,
			"Couldn't link that button to the original conversation — please reply with `yes` / `no` / `search` instead.",
			config.delivery,
		);
		return;
	}

	await dispatchInbound(synthetic, config, account);
}
