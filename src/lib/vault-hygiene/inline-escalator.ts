/** ADR-042 — Inline-button escalator (Step 3, pilot).
 *
 *  Reads the latest project-hygiene digest, scans for
 *  `archive_zone_mismatch` rows, and sends one Telegram message per
 *  row with the inline keyboard from `callback.ts`.
 *
 *  Pilot scope:
 *   - Only the `archive_zone_mismatch` bucket gets buttons. Other
 *     buckets continue to surface as text via the existing keeper
 *     escalation path.
 *   - Manually triggered via `/api/hygiene/escalate-buttons`. Once
 *     validated end-to-end, wiring to a scheduler hook lands in
 *     ADR-042 pass 2.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sendText } from '../channels/telegram/outbound.js';
import {
	buildHygieneArchiveZoneKeyboard,
	rememberHygieneButtons,
} from '../channels/telegram/callback.js';
import { config as soulHubConfig } from '../config.js';

const VAULT = join(homedir(), 'vault');
const INBOX = join(VAULT, 'inbox');
const HYGIENE_DIR = join(VAULT, 'operations', 'hygiene');

const DIGEST_FILE_RX = /^\d{4}-\d{2}-\d{2}-project-hygiene\.md$/;

export interface EscalationResult {
	ok: boolean;
	digestPath?: string;
	totalRows?: number;
	sent?: number;
	failures?: { slug: string; error: string }[];
	error?: string;
}

/** Walk both digest locations, return path to the most recent file. */
async function findLatestDigest(): Promise<string | null> {
	const candidates: { path: string; ts: string }[] = [];

	async function scan(dir: string): Promise<void> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const e of entries) {
				if (e.isFile() && DIGEST_FILE_RX.test(e.name)) {
					candidates.push({ path: join(dir, e.name), ts: e.name.slice(0, 10) });
				} else if (e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name)) {
					await scan(join(dir, e.name));
				}
			}
		} catch {
			/* dir missing — ignore */
		}
	}

	await scan(INBOX);
	await scan(HYGIENE_DIR);

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.ts.localeCompare(a.ts));
	return candidates[0].path;
}

/** Extract archive_zone_mismatch slugs from a digest body.
 *  Looks for the section heading and reads bullet rows until the next
 *  heading. Bullet format from the renderer:
 *    `- [[projects/<slug>/index|<slug>]] — idle Nd` */
export function parseArchiveZoneSlugs(digestBody: string): string[] {
	const lines = digestBody.split('\n');
	const slugs: string[] = [];
	let inSection = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('## ')) {
			inSection = trimmed.toLowerCase().includes('archive-zone mismatch');
			continue;
		}
		if (!inSection) continue;
		if (!trimmed.startsWith('- ')) continue;
		const m = trimmed.match(/\[\[projects\/([a-z][a-z0-9-]*)\/index/);
		if (m) slugs.push(m[1]);
	}
	return slugs;
}

function resolveTelegramChatId(): string | null {
	const fromConfig = soulHubConfig.channels?.telegram?.access?.allowFrom?.[0];
	if (fromConfig) return String(fromConfig);
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

/** Send one inline-keyboard message per archive_zone_mismatch row in the
 *  latest digest. Idempotent enough for the pilot — if called twice in
 *  quick succession the second call produces duplicate messages, but
 *  rememberHygieneButtons keys on (slug,bucket) so callback resolution
 *  still points at the latest message id. */
export async function emitArchiveZoneEscalations(): Promise<EscalationResult> {
	const digestPath = await findLatestDigest();
	if (!digestPath) return { ok: false, error: 'no-digest-found' };

	const body = await readFile(digestPath, 'utf-8');
	const slugs = parseArchiveZoneSlugs(body);
	if (slugs.length === 0) {
		return { ok: true, digestPath, totalRows: 0, sent: 0, failures: [] };
	}

	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };

	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const failures: { slug: string; error: string }[] = [];
	let sent = 0;

	for (const slug of slugs) {
		const text =
			`📦 *Archive-zone mismatch* — \`${slug}\`\n\n` +
			`Status is \`archived\` but the folder still sits under \`projects/\`. ` +
			`Tap to move it to \`archive/\`, pause for 60 days, or ignore for 30.`;
		const result = await sendText(chatId, text, delivery, {
			replyMarkup: buildHygieneArchiveZoneKeyboard(slug, 'archive_zone_mismatch'),
		});
		if (!result.ok || result.messageIds.length === 0) {
			failures.push({ slug, error: result.error ?? 'send-failed' });
			continue;
		}
		rememberHygieneButtons({
			slug,
			bucket: 'archive_zone_mismatch',
			chatJid: String(chatId),
			messageId: result.messageIds[0],
		});
		sent++;
	}

	return { ok: true, digestPath, totalRows: slugs.length, sent, failures };
}
