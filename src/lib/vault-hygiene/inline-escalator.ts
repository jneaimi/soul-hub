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

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sendText } from '../channels/telegram/outbound.js';
import {
	buildHygieneKeyboardFor,
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
	skipped?: number;
	failures?: { slug: string; error: string }[];
	error?: string;
}

/** Cross-run dedup state. Keyed on (digestPath, mtimeMs) so a freshly
 *  rewritten digest (Python script reruns) gets a fresh tracking set,
 *  while repeated curls of the same digest skip already-sent rows.
 *  Restart-loss accepted — the digest only writes weekly. */
let lastEmittedKey: string | null = null;
const emittedFromCurrentDigest = new Set<string>(); // `${slug}:${bucket}`

/** Test-only: reset dedup state. Production paths don't call this. */
export function _resetEscalatorDedupState(): void {
	lastEmittedKey = null;
	emittedFromCurrentDigest.clear();
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

/** Map from a digest section heading to the bucket key the escalator
 *  should attribute its messages to. Add an entry when extending to a
 *  new bucket — keeps the parser declarative and the bucket→action
 *  mapping centralised. */
const SECTION_TO_BUCKET: { match: string; bucket: string }[] = [
	{ match: 'archive-zone mismatch', bucket: 'archive_zone_mismatch' },
	{ match: 'empty stub', bucket: 'empty_stub' },
	{ match: 'template-only', bucket: 'template_only_index' },
	{ match: 'stale `active` (30+', bucket: 'stale_active_30' },
	{ match: 'stale `active` (14', bucket: 'stale_active_14' },
	{ match: '`complete` but recently touched', bucket: 'complete_recent_activity' },
	{ match: 'needs `status:` field', bucket: 'no_status' },
	{ match: 'missing `index.md`', bucket: 'missing_index' },
];

interface DigestRow {
	slug: string;
	bucket: string;
}

/** Extract (slug, bucket) rows for every actionable section in the
 *  digest body. Bullet format from the renderer:
 *    `- [[projects/<slug>/index|<slug>]] — ...`
 *  Sections not in SECTION_TO_BUCKET are ignored (the escalator only
 *  emits buttons for buckets it has built keyboards for). */
export function parseActionableRows(digestBody: string): DigestRow[] {
	const lines = digestBody.split('\n');
	const rows: DigestRow[] = [];
	let currentBucket: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('## ')) {
			const lower = trimmed.toLowerCase();
			const hit = SECTION_TO_BUCKET.find((s) => lower.includes(s.match));
			currentBucket = hit?.bucket ?? null;
			continue;
		}
		if (!currentBucket) continue;
		if (!trimmed.startsWith('- ')) continue;
		// Two bullet formats from the python renderer:
		//   wiki style: `- [[projects/<slug>/index|<slug>]] — ...` (most buckets)
		//   bare style: `- \`<slug>/\`` (missing_index only)
		const wiki = trimmed.match(/\[\[projects\/([a-z][a-z0-9-]*)\/index/);
		if (wiki) {
			rows.push({ slug: wiki[1], bucket: currentBucket });
			continue;
		}
		const bare = trimmed.match(/^- `([a-z][a-z0-9-]*)\/?`/);
		if (bare) {
			rows.push({ slug: bare[1], bucket: currentBucket });
		}
	}
	return rows;
}

/** Legacy export — kept for the existing smoke test. */
export function parseArchiveZoneSlugs(digestBody: string): string[] {
	return parseActionableRows(digestBody)
		.filter((r) => r.bucket === 'archive_zone_mismatch')
		.map((r) => r.slug);
}

function resolveTelegramChatId(): string | null {
	const fromConfig = soulHubConfig.channels?.telegram?.access?.allowFrom?.[0];
	if (fromConfig) return String(fromConfig);
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

/** Compose the per-row escalation text. Bucket-specific prose so the
 *  operator instantly understands what the buttons will do. */
function formatRowMessage(slug: string, bucket: string): string {
	switch (bucket) {
		case 'archive_zone_mismatch':
			return (
				`📦 *Archive-zone mismatch* — \`${slug}\`\n\n` +
				`Status is \`archived\` but the folder still sits under \`projects/\`. ` +
				`Tap to move it to \`archive/\`, pause for 60 days, or ignore for 30.`
			);
		case 'empty_stub':
			return (
				`🪹 *Empty stub* — \`${slug}\`\n\n` +
				`\`index.md\` body is small and has zero content under any section — ` +
				`auto-scaffolded but never grew. Tap to archive (flips status + moves), ` +
				`pause for 60 days, or ignore for 30.`
			);
		case 'template_only_index':
			return (
				`📄 *Template-only index* — \`${slug}\`\n\n` +
				`Body is the auto-scaffold boilerplate. No real index content has been written. ` +
				`Tap to archive (flips status + moves), pause for 60 days, or ignore for 30.`
			);
		case 'stale_active_14':
			return (
				`🟡 *Stale active (14d+)* — \`${slug}\`\n\n` +
				`Marked active but no file touched in 14+ days. Confirm activity, ` +
				`pause for 30 days, or archive.`
			);
		case 'stale_active_30':
			return (
				`🟠 *Stale active (30d+)* — \`${slug}\`\n\n` +
				`Marked active but no file touched in 30+ days — likely lying. ` +
				`Confirm activity, reconcile to \`maintained\`, or archive.`
			);
		case 'complete_recent_activity':
			return (
				`🤔 *Complete but recently touched* — \`${slug}\`\n\n` +
				`Status is \`complete\` but a file was edited in the past week. ` +
				`Re-opened, or polish pass? Reconcile the status.`
			);
		case 'no_status':
			return (
				`🏷 *No status* — \`${slug}\`\n\n` +
				`Project has no \`status:\` frontmatter field. Mark it active, archive, ` +
				`or ignore.`
			);
		case 'missing_index':
			return (
				`📂 *Missing \`index.md\`* — \`${slug}\`\n\n` +
				`Folder exists but has no index.md. Scaffold a stub or archive the folder.`
			);
		default:
			return `⚠️ *${bucket}* — \`${slug}\`\n\nReview and decide.`;
	}
}

/** Send one inline-keyboard message per actionable row in the latest
 *  digest. Iterates both `archive_zone_mismatch` and `empty_stub`
 *  sections. Idempotent enough for the pilot — `rememberHygieneButtons`
 *  keys on (slug, bucket) so duplicate calls overwrite rather than
 *  accumulate. */
export async function emitInlineEscalations(): Promise<EscalationResult> {
	const digestPath = await findLatestDigest();
	if (!digestPath) return { ok: false, error: 'no-digest-found' };

	const digestStat = await stat(digestPath);
	const digestKey = `${digestPath}:${digestStat.mtimeMs}`;
	// Fresh digest (different file or rewritten) → reset the dedup set.
	if (digestKey !== lastEmittedKey) {
		lastEmittedKey = digestKey;
		emittedFromCurrentDigest.clear();
	}

	const body = await readFile(digestPath, 'utf-8');
	const rows = parseActionableRows(body);
	if (rows.length === 0) {
		return { ok: true, digestPath, totalRows: 0, sent: 0, skipped: 0, failures: [] };
	}

	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };

	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const failures: { slug: string; error: string }[] = [];
	let sent = 0;
	let skipped = 0;

	for (const row of rows) {
		const rowKey = `${row.slug}:${row.bucket}`;
		if (emittedFromCurrentDigest.has(rowKey)) {
			skipped++;
			continue;
		}
		const text = formatRowMessage(row.slug, row.bucket);
		const result = await sendText(chatId, text, delivery, {
			replyMarkup: buildHygieneKeyboardFor(row.slug, row.bucket),
		});
		if (!result.ok || result.messageIds.length === 0) {
			failures.push({ slug: row.slug, error: result.error ?? 'send-failed' });
			continue;
		}
		rememberHygieneButtons({
			slug: row.slug,
			bucket: row.bucket,
			chatJid: String(chatId),
			messageId: result.messageIds[0],
		});
		emittedFromCurrentDigest.add(rowKey);
		sent++;
	}

	return { ok: true, digestPath, totalRows: rows.length, sent, skipped, failures };
}

/** Legacy export — kept so the scheduler handler and existing callers
 *  keep working while pass 2 settles. Delegates to the generalized
 *  emitter. */
export const emitArchiveZoneEscalations = emitInlineEscalations;
