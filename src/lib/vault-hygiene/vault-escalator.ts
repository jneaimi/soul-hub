/** ADR-043 — vault-hygiene inline-button escalator (pilot).
 *
 *  Reads the fresh hygiene report from `getHygieneReport()` directly
 *  (no markdown digest middle-step, unlike project-hygiene's escalator).
 *  Emits one Telegram message per actionable anomaly with the
 *  appropriate bucket-aware keyboard from `callback.ts`.
 *
 *  Pilot scope: `unresolved` bucket only (broken wikilinks). Other
 *  vault-hygiene anomaly types (orphans, stale inbox) land in pass 2
 *  once the broken-link path validates.
 *
 *  Trigger: manual via `POST /api/hygiene/vault-escalate-buttons` for
 *  the pilot. Auto-trigger via `heartbeat-tick.ts` integration lands
 *  in pass 2 alongside the other buckets.
 *
 *  Suppression: shares `~/.soul-hub/data/hygiene-suppressions.json`
 *  with project-hygiene. Vault-hygiene entries use a composite key
 *  (`source::raw`) so suppression is per-link, not per-source-file.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sendText } from '../channels/telegram/outbound.js';
import {
	buildVaultHygieneUnresolvedKeyboard,
	rememberVaultHygieneButtons,
} from '../channels/telegram/callback.js';
import { config as soulHubConfig } from '../config.js';
import { getVaultEngine } from '../vault/index.js';
import type { UnresolvedIssue } from './types.js';

/** Per-emission cap. The hygiene report caps at ISSUE_LIST_CAP (20) for
 *  display purposes; the escalator applies the cap AFTER suppression so
 *  the operator only sees actionable rows, not noise they've already
 *  ignored. */
const EMIT_CAP = 20;

const SUPPRESSIONS_PATH = join(homedir(), '.soul-hub', 'data', 'hygiene-suppressions.json');

export interface VaultEscalationResult {
	ok: boolean;
	totalRows?: number;
	sent?: number;
	skipped?: number;
	failures?: { source: string; raw: string; error: string }[];
	error?: string;
}

interface SuppressionEntry {
	slug?: string;
	key?: string;
	bucket: string;
	until: string;
}

/** Build the composite key for a broken-link suppression. Uses the
 *  source path + literal raw text so multiple broken links in the
 *  same file can be suppressed independently. */
export function vaultHygieneKeyFor(source: string, raw: string): string {
	return `${source}::${raw}`;
}

async function loadActiveSuppressions(bucket: string): Promise<Set<string>> {
	try {
		const text = await readFile(SUPPRESSIONS_PATH, 'utf-8');
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return new Set();
		const today = new Date().toISOString().slice(0, 10);
		const active = new Set<string>();
		for (const entry of parsed as SuppressionEntry[]) {
			if (entry?.bucket !== bucket) continue;
			if (typeof entry.until !== 'string') continue;
			if (entry.until <= today) continue;
			const key = entry.key ?? entry.slug;
			if (typeof key === 'string') active.add(key);
		}
		return active;
	} catch {
		return new Set();
	}
}

function resolveTelegramChatId(): string | null {
	const fromConfig = soulHubConfig.channels?.telegram?.access?.allowFrom?.[0];
	if (fromConfig) return String(fromConfig);
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

function formatUnresolvedMessage(issue: UnresolvedIssue): string {
	return (
		`🔗 *Broken wikilink* — \`${issue.source}\`\n\n` +
		`\`[[${issue.raw}]]\` doesn't resolve. Tap *🗑 Unlink* to replace the link with its ` +
		`display text in place (reversible via git), or *🔇 Ignore* to suppress for 30 days.`
	);
}

/** Per-run dedup: skip emitting if the same (source, raw) was already
 *  sent in this process for the current hygiene report. Resets when
 *  `report.generatedAt` changes. */
let lastEmittedAt: string | null = null;
const emittedThisRun = new Set<string>();

export function _resetVaultEscalatorDedupState(): void {
	lastEmittedAt = null;
	emittedThisRun.clear();
}

export async function emitVaultHygieneEscalations(): Promise<VaultEscalationResult> {
	const chatId = resolveTelegramChatId();
	if (!chatId) return { ok: false, error: 'no-telegram-chat-id' };
	const delivery = soulHubConfig.channels?.telegram?.delivery;
	if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

	const engine = getVaultEngine();
	if (!engine) return { ok: false, error: 'vault-engine-not-ready' };

	// Pull the FULL unresolved set from the engine directly. The hygiene
	// report's 20-cap is a display affordance, not a policy — for the
	// escalator we want suppression to take effect across the entire pool
	// before we apply our own emission cap.
	const allUnresolved = engine.getUnresolved();
	const generatedAt = new Date().toISOString();

	// Refresh dedup state when the generated timestamp changes (each
	// emission cycle gets a fresh window). On manual reruns within the
	// same second this collapses to "skip what we already sent this run".
	if (generatedAt !== lastEmittedAt) {
		lastEmittedAt = generatedAt;
		emittedThisRun.clear();
	}

	if (allUnresolved.length === 0) {
		return { ok: true, totalRows: 0, sent: 0, skipped: 0, failures: [] };
	}

	const suppressed = await loadActiveSuppressions('unresolved');

	const failures: { source: string; raw: string; error: string }[] = [];
	let sent = 0;
	let skipped = 0;

	for (const link of allUnresolved) {
		if (sent >= EMIT_CAP) break;
		const issue: UnresolvedIssue = {
			source: link.source,
			raw: link.raw,
			suggestedFix: `Fuzzy-match \`${link.raw}\` against vault titles in \`${link.source}\` directory; correct the link or remove the line.`,
		};
		const key = vaultHygieneKeyFor(issue.source, issue.raw);
		if (suppressed.has(key) || emittedThisRun.has(key)) {
			skipped++;
			continue;
		}
		const text = formatUnresolvedMessage(issue);
		const result = await sendText(chatId, text, delivery, {
			replyMarkup: buildVaultHygieneUnresolvedKeyboard(issue.source, issue.raw),
		});
		if (!result.ok || result.messageIds.length === 0) {
			failures.push({
				source: issue.source,
				raw: issue.raw,
				error: result.error ?? 'send-failed',
			});
			continue;
		}
		rememberVaultHygieneButtons({
			source: issue.source,
			raw: issue.raw,
			bucket: 'unresolved',
			chatJid: String(chatId),
			messageId: result.messageIds[0],
		});
		emittedThisRun.add(key);
		sent++;
	}

	return { ok: true, totalRows: allUnresolved.length, sent, skipped, failures };
}
