/** Outbound delivery — text chunking, plus media (image/video/audio/
 *  document). Media is read off disk and shipped as a Baileys media
 *  payload; mimetype falls back to extension-based detection. */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { WASocket } from '@whiskeysockets/baileys';
import type { OutboundMedia, WhatsAppDeliveryConfig } from './types.js';
import { mimeFromPath } from './media.js';

/** Split `text` into chunks ≤ `limit`. `mode: 'newline'` prefers paragraph
 *  boundaries; falls back to hard cuts when a single block exceeds the
 *  limit. `mode: 'hard'` slices blindly. */
export function chunkText(
	text: string,
	limit: number,
	mode: 'newline' | 'hard',
): string[] {
	if (text.length <= limit) return text.length === 0 ? [] : [text];

	if (mode === 'hard') {
		const out: string[] = [];
		for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
		return out;
	}

	const paragraphs = text.split(/\n{2,}/);
	const out: string[] = [];
	let buffer = '';

	const flushBuffer = () => {
		if (buffer.length > 0) {
			out.push(buffer);
			buffer = '';
		}
	};

	for (const para of paragraphs) {
		const candidate = buffer ? `${buffer}\n\n${para}` : para;
		if (candidate.length <= limit) {
			buffer = candidate;
			continue;
		}
		flushBuffer();
		if (para.length <= limit) {
			buffer = para;
		} else {
			// Single paragraph too long — fall through to hard chunks.
			for (let i = 0; i < para.length; i += limit) {
				out.push(para.slice(i, i + limit));
			}
		}
	}
	flushBuffer();
	return out;
}

export async function sendText(
	sock: WASocket,
	chatJid: string,
	text: string,
	delivery: WhatsAppDeliveryConfig,
): Promise<{ ok: boolean; messageIds: string[]; error?: string }> {
	const chunks = chunkText(text, delivery.textChunkLimit, delivery.chunkMode);
	if (chunks.length === 0) {
		return { ok: false, messageIds: [], error: 'empty body' };
	}

	const ids: string[] = [];
	for (const chunk of chunks) {
		try {
			const result = await sock.sendMessage(chatJid, { text: chunk });
			if (result?.key?.id) ids.push(result.key.id);
		} catch (err) {
			return {
				ok: false,
				messageIds: ids,
				error: (err as Error).message,
			};
		}
	}
	return { ok: true, messageIds: ids };
}

/** Edit a previously sent text message in place. Used by the orchestrator
 *  progress streaming (ADR-005 Phase 2) to morph a single "🟡 Working…"
 *  bubble into "✅ done" instead of spamming the chat with milestone
 *  messages. The WAMessageKey is reconstructed from the messageId we
 *  captured when sending the original — sender-side messages have
 *  `fromMe: true` and `remoteJid: chatJid`. */
export async function editText(
	sock: WASocket,
	chatJid: string,
	messageId: string,
	newText: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		await sock.sendMessage(
			chatJid,
			{ text: newText, edit: { remoteJid: chatJid, id: messageId, fromMe: true } },
		);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** React to an inbound message (e.g. the 👀 ack emoji). Best-effort —
 *  reaction failures don't break the reply path. */
export async function reactTo(
	sock: WASocket,
	chatJid: string,
	messageId: string,
	emoji: string,
	fromMe = false,
): Promise<void> {
	try {
		await sock.sendMessage(chatJid, {
			react: {
				text: emoji,
				key: { remoteJid: chatJid, id: messageId, fromMe },
			},
		});
	} catch {
		/* swallowed — reaction is decorative */
	}
}

/** Send media from a local file. Reads the bytes synchronously since
 *  WhatsApp's per-message size limit is bounded (~16MB audio, ~100MB
 *  video) — small enough that streaming complexity isn't justified yet.
 *  Documents preserve their on-disk filename unless the caller passes
 *  an override. */
export async function sendMedia(
	sock: WASocket,
	chatJid: string,
	media: OutboundMedia,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
	let buffer: Buffer;
	try {
		buffer = readFileSync(media.path);
	} catch (err) {
		return { ok: false, error: `read failed: ${(err as Error).message}` };
	}

	const mimetype = media.mimetype ?? mimeFromPath(media.path);
	const fileName = media.fileName ?? basename(media.path);
	const caption = media.caption?.length ? media.caption : undefined;

	try {
		let result;
		switch (media.kind) {
			case 'image':
				result = await sock.sendMessage(chatJid, {
					image: buffer,
					mimetype,
					caption,
				});
				break;
			case 'video':
				result = await sock.sendMessage(chatJid, {
					video: buffer,
					mimetype,
					caption,
				});
				break;
			case 'audio':
				result = await sock.sendMessage(chatJid, {
					audio: buffer,
					mimetype,
				});
				break;
			case 'document':
				result = await sock.sendMessage(chatJid, {
					document: buffer,
					mimetype,
					fileName,
					caption,
				});
				break;
		}
		return { ok: true, messageId: result?.key?.id ?? undefined };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}
