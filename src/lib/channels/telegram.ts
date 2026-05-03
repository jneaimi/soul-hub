import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChannelAdapter, ChannelMeta, SendResult, TestResult } from './types.js';

const API_BASE = 'https://api.telegram.org/bot';

export const meta: ChannelMeta = {
	id: 'telegram',
	name: 'Telegram',
	icon: 'send',
	fields: [
		{
			key: 'token',
			label: 'Bot Token',
			type: 'secret',
			env: 'TELEGRAM_BOT_TOKEN',
			required: true,
			link: 'https://core.telegram.org/bots#botfather',
		},
		{
			key: 'chatId',
			label: 'Chat ID',
			type: 'secret',
			env: 'TELEGRAM_CHAT_ID',
			required: true,
		},
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

/** Map an HTTP/Telegram outcome to a TestStatus. */
function mapStatus(httpStatus: number, body?: unknown): TestResult {
	if (httpStatus === 200) {
		return { ok: true, status: 'ok' };
	}
	if (httpStatus === 401) {
		return { ok: false, status: 'unauthorized', message: 'Bot token rejected.' };
	}
	if (httpStatus === 404) {
		// Common case for getChat: chat not found / bot not in it
		return { ok: false, status: 'invalid', message: 'Chat not found or bot has no access.' };
	}
	if (httpStatus === 429) {
		return { ok: false, status: 'ratelimit', message: 'Telegram rate limit hit — try again shortly.' };
	}
	const description =
		body && typeof body === 'object' && 'description' in body
			? String((body as { description: unknown }).description)
			: undefined;
	return { ok: false, status: 'invalid', message: description ?? `HTTP ${httpStatus}` };
}

/** Test Telegram credentials with two cheap calls: `getMe` validates the
 *  token; if a chat id is set, `getChat` validates it points at a real chat
 *  the bot can reach. */
async function test(): Promise<TestResult> {
	const token = getToken();
	const chatId = getChatId();
	if (!token) {
		return { ok: false, status: 'unconfigured', message: 'TELEGRAM_BOT_TOKEN is not set.' };
	}

	try {
		const meRes = await fetch(`${API_BASE}${token}/getMe`);
		const meBody = await meRes.json().catch(() => undefined);
		const meResult = mapStatus(meRes.status, meBody);
		if (!meResult.ok) return meResult;

		// Token works. If chat id is set, verify it too.
		if (chatId) {
			const chatRes = await fetch(`${API_BASE}${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
			const chatBody = await chatRes.json().catch(() => undefined);
			const chatResult = mapStatus(chatRes.status, chatBody);
			if (!chatResult.ok) return chatResult;
		}
		return { ok: true, status: 'ok' };
	} catch (err) {
		return { ok: false, status: 'network', message: (err as Error).message };
	}
}

/** Telegram adapter */
export const adapter: ChannelAdapter = {
	meta,
	send,
	isConfigured,
	test,
};
