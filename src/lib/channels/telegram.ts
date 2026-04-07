import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChannelAdapter, ChannelMeta, SendResult } from './types.js';

const API_BASE = 'https://api.telegram.org/bot';

export const meta: ChannelMeta = {
	id: 'telegram',
	name: 'Telegram',
	icon: 'send',
	fields: [
		{ key: 'token', label: 'Bot Token', type: 'secret', env: 'TELEGRAM_BOT_TOKEN' },
		{ key: 'chatId', label: 'Chat ID', type: 'secret', env: 'TELEGRAM_CHAT_ID' },
	],
	actions: ['send'],
};

function getToken(): string | undefined {
	return process.env.TELEGRAM_BOT_TOKEN;
}

function getChatId(): string | undefined {
	return process.env.TELEGRAM_CHAT_ID;
}

export function isConfigured(): boolean {
	return !!(getToken() && getChatId());
}

/** Send a text message via Telegram Bot API */
async function sendMessage(text: string): Promise<SendResult> {
	const token = getToken();
	const chatId = getChatId();
	if (!token || !chatId) {
		return { ok: false, error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' };
	}

	try {
		const res = await fetch(`${API_BASE}${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text,
				parse_mode: 'Markdown',
			}),
		});
		const data = await res.json();
		if (data.ok) {
			return { ok: true, messageId: String(data.result?.message_id) };
		}
		return { ok: false, error: data.description || 'Telegram API error' };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** Send a document (file) via Telegram Bot API */
async function sendDocument(filePath: string, caption?: string): Promise<SendResult> {
	const token = getToken();
	const chatId = getChatId();
	if (!token || !chatId) {
		return { ok: false, error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' };
	}

	try {
		// Check file exists and isn't too large (Telegram limit: 50MB)
		const fileStat = await stat(filePath);
		if (fileStat.size > 50 * 1024 * 1024) {
			return { ok: false, error: 'File exceeds Telegram 50MB limit' };
		}

		const fileBuffer = await readFile(filePath);
		const fileName = basename(filePath);

		const form = new FormData();
		form.append('chat_id', chatId);
		form.append('document', new Blob([fileBuffer]), fileName);
		if (caption) form.append('caption', caption);
		form.append('parse_mode', 'Markdown');

		const res = await fetch(`${API_BASE}${token}/sendDocument`, {
			method: 'POST',
			body: form,
		});
		const data = await res.json();
		if (data.ok) {
			return { ok: true, messageId: String(data.result?.message_id) };
		}
		return { ok: false, error: data.description || 'Telegram API error' };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** Send a message and optionally attach a file */
export async function send(message: string, attachPath?: string): Promise<SendResult> {
	if (attachPath) {
		// Send document with message as caption
		return sendDocument(attachPath, message);
	}
	return sendMessage(message);
}

/** Telegram adapter */
export const adapter: ChannelAdapter = {
	meta,
	send,
	isConfigured,
};
