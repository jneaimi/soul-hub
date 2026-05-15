/** Inline-keyboard `callback_query` handler.
 *
 *  Telegram inline-keyboard buttons fire a `callback_query` with the
 *  button's `callback_data` payload. Button families:
 *
 *  1. **Proposal** (ADR-011) — verbs `confirm` / `decline` / `web`.
 *     Resolved by re-entering the inbound dispatcher with a synthetic
 *     "yes" / "no" / "search" message so the orchestrator's proposal
 *     pipeline runs identically to a typed reply.
 *
 *  2. **YouTube follow-up** (ADR-014) — verbs `yt-save` / `yt-tx` /
 *     `yt-skip`. Resolved INLINE (no orchestrator round-trip) because
 *     the user's intent is unambiguous and we already cached the video
 *     context from the prior summary turn. Skipping the LLM saves
 *     latency + cost.
 *
 *  3. **Hygiene remediation** (ADR-042) — verbs `hyg-arc` (+ confirm
 *     `hyg-arc-y` / cancel `hyg-arc-n`), `hyg-pause`, `hyg-ig`.
 *     Triggered by keeper escalations for project-hygiene anomalies.
 *     Resolved INLINE; archive uses confirm-then-execute since the
 *     file move is destructive (reversible via git, but worth one
 *     extra tap to prevent misclicks).
 *
 *  callback_data layout: `<verb>:<short_id>` where short_id is the
 *  base64url'd SHA-1 of the conversationKey, fitting inside Telegram's
 *  64-byte cap and avoiding leaking the raw key (DM ids look like phone
 *  numbers when prefixed). All mappings are held in-process;
 *  restart-loss is acceptable because both proposal expiry and the
 *  YouTube-button TTL are on the same timescale as PM2 restarts. */

import { createHash } from 'node:crypto';
import { answerCallbackQuery, editMessageText } from './client.js';
import { sendText } from './outbound.js';
import { dispatchInbound, conversationKeyFor } from './dispatch.js';
import { dispatchVaultSave } from '../../vault-save/index.js';
import { fetchYoutube } from '../../youtube/index.js';
import {
	archiveProject,
	setPauseUntil,
	setProjectStatus,
	suppressAnomaly,
} from '../../vault-hygiene/actions.js';
import { getVaultEngine } from '../../vault/index.js';
import {
	getYoutubeCount,
	incrementYoutubeCount,
	ymdInTimezone,
} from '../whatsapp/heartbeat-state.js';
import {
	listProposed,
	getProposed,
	promoteProposal,
	rejectProposal,
	promoteAllInBatch,
	deferBatch,
	type ProposedRow,
} from '../../intent/patterns.js';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import type {
	InboundEnvelope,
	InlineKeyboardMarkup,
	TelegramChannelConfig,
	TgCallbackQuery,
} from './types.js';

type Verb = 'confirm' | 'decline' | 'web';
type YoutubeVerb = 'yt-save' | 'yt-tx' | 'yt-skip';
type IntentVerb = 'ip-review' | 'ip-all' | 'ip-skip' | 'ip-yes' | 'ip-no';
type HygieneVerb = 'hyg-arc' | 'hyg-arc-y' | 'hyg-arc-n' | 'hyg-pause' | 'hyg-ig';

interface PendingButtonRow {
	conversationKey: string;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

interface PendingYoutubeRow {
	conversationKey: string;
	chatJid: string;
	senderId: string;
	messageId: number;
	videoUrl: string;
	title: string;
	summary: string;
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

// ─── YouTube follow-up keyboard (ADR-014) ──────────────────────────────

/** Per-conversation cache of the most-recent YouTube reply that has
 *  follow-up buttons attached. Keyed by short_id (same scheme as
 *  proposal buttons) so callback_data stays compact. Only one row per
 *  conversation — a fresh YouTube turn replaces the prior cache. */
const pendingYoutubeButtons = new Map<string, PendingYoutubeRow>();

export function buildYoutubeKeyboard(conversationKey: string): InlineKeyboardMarkup {
	const id = shortIdFor(conversationKey);
	return {
		inline_keyboard: [
			[
				{ text: '💾 Save to vault', callback_data: `yt-save:${id}` },
				{ text: '📄 Full transcript', callback_data: `yt-tx:${id}` },
			],
			[{ text: '✗ Skip', callback_data: `yt-skip:${id}` }],
		],
	};
}

export function rememberYoutubeButtons(args: {
	conversationKey: string;
	chatJid: string;
	senderId: string;
	messageId: number;
	videoUrl: string;
	title: string;
	summary: string;
}): void {
	const id = shortIdFor(args.conversationKey);
	pendingYoutubeButtons.set(id, {
		...args,
		createdAt: Date.now(),
	});
	// Lazy GC.
	const now = Date.now();
	for (const [k, v] of pendingYoutubeButtons) {
		if (now - v.createdAt > PENDING_TTL_MS) pendingYoutubeButtons.delete(k);
	}
}

type ProposalParse = { kind: 'proposal'; verb: Verb; id: string };
type YoutubeParse = { kind: 'youtube'; verb: YoutubeVerb; id: string };
type IntentParse = { kind: 'intent'; verb: IntentVerb; id: string };
type HygieneParse = { kind: 'hygiene'; verb: HygieneVerb; id: string };
type ParsedCallback = ProposalParse | YoutubeParse | IntentParse | HygieneParse;

function parseCallbackData(data: string): ParsedCallback | null {
	const i = data.indexOf(':');
	if (i === -1) return null;
	const verb = data.slice(0, i);
	const id = data.slice(i + 1);
	if (!id) return null;
	if (verb === 'confirm' || verb === 'decline' || verb === 'web') {
		return { kind: 'proposal', verb, id };
	}
	if (verb === 'yt-save' || verb === 'yt-tx' || verb === 'yt-skip') {
		return { kind: 'youtube', verb, id };
	}
	if (
		verb === 'ip-review' ||
		verb === 'ip-all' ||
		verb === 'ip-skip' ||
		verb === 'ip-yes' ||
		verb === 'ip-no'
	) {
		return { kind: 'intent', verb, id };
	}
	if (
		verb === 'hyg-arc' ||
		verb === 'hyg-arc-y' ||
		verb === 'hyg-arc-n' ||
		verb === 'hyg-pause' ||
		verb === 'hyg-ig'
	) {
		return { kind: 'hygiene', verb, id };
	}
	return null;
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

/** Handle a `callback_query` Update. Routes to the proposal-button or
 *  YouTube-button handler based on the parsed verb. */
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

	if (parsed.kind === 'proposal') {
		await handleProposalCallback(query, parsed, config, account);
		return;
	}
	if (parsed.kind === 'intent') {
		await handleIntentCallback(query, parsed, config);
		return;
	}
	if (parsed.kind === 'hygiene') {
		await handleHygieneCallback(query, parsed, config);
		return;
	}
	await handleYoutubeCallback(query, parsed, config);
}

/** Proposal-button branch (ADR-011). Resolves the button to its
 *  conversation, then re-enters the inbound dispatcher with a synthetic
 *  text message ("yes" / "no" / "search") so the proposal-confirmation
 *  pathway runs identically to a typed reply. */
async function handleProposalCallback(
	query: TgCallbackQuery,
	parsed: ProposalParse,
	config: TelegramChannelConfig,
	account: string,
): Promise<void> {
	const row = pendingButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Buttons expired — send a new message to retry.',
			show_alert: false,
		});
		return;
	}

	await answerCallbackQuery({
		callback_query_id: query.id,
		text: VERB_TO_CONFIRMATION[parsed.verb],
	});

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

/** YouTube follow-up branch (ADR-014). Bypasses the orchestrator —
 *  the user's intent is unambiguous (they tapped a specific button) and
 *  we already cached the video context, so going through the LLM would
 *  add latency + cost without changing the outcome.
 *
 *  - yt-save: dispatch vaultSave with cached title/summary/url
 *  - yt-tx:   re-fetch via youtubeFetch with mode=transcript (consumes
 *             the per-day Gemini quota, same as the original tool path)
 *  - yt-skip: just strip buttons + ack */
async function handleYoutubeCallback(
	query: TgCallbackQuery,
	parsed: YoutubeParse,
	config: TelegramChannelConfig,
): Promise<void> {
	const row = pendingYoutubeButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Buttons expired — paste the link again to retry.',
			show_alert: false,
		});
		return;
	}

	if (parsed.verb === 'yt-skip') {
		await answerCallbackQuery({ callback_query_id: query.id, text: '✗ Dismissed.' });
		await stripYoutubeButtons(row, '✗ Dismissed.');
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	if (parsed.verb === 'yt-save') {
		// Acknowledge fast — vault writes are quick but we want the spinner
		// gone within Telegram's ~10s window.
		await answerCallbackQuery({ callback_query_id: query.id, text: '💾 Saving…' });
		const outcome = await dispatchVaultSave({
			title: row.title,
			content: buildSaveBody(row),
			type: 'reference',
			tags: ['youtube', 'video'],
			sourceUrl: row.videoUrl,
			channel: 'telegram',
		});
		if (outcome.ok) {
			await stripYoutubeButtons(row, `💾 Saved as *${row.title}* — ${outcome.openUrl}`);
		} else {
			await stripYoutubeButtons(row, `Couldn't save: ${outcome.error}`);
		}
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	// yt-tx — full transcript fetch. Re-checks the per-day Gemini quota
	// the same way the youtubeFetch tool does so a button-tap can't bypass
	// the cap.
	await answerCallbackQuery({ callback_query_id: query.id, text: '📄 Fetching transcript…' });

	const ytConfig = readYoutubeConfig();
	if (!ytConfig?.enabled) {
		await sendText(
			row.chatJid,
			'Transcript fetch is disabled in settings.',
			config.delivery,
		);
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	const tz = 'Asia/Dubai';
	const today = ymdInTimezone(tz);
	const count = getYoutubeCount(row.senderId, today);
	const overCap = count >= ytConfig.maxPerDay;

	const out = await fetchYoutube(row.videoUrl, {
		mode: 'transcript',
		youtubeConfig: ytConfig,
		transcriptQuotaExceeded: overCap,
	});

	if (!out.ok) {
		await sendText(
			row.chatJid,
			`Couldn't fetch transcript: ${out.error.error}`,
			config.delivery,
		);
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	if (out.result.transcriptSource === 'gemini' && !overCap) {
		incrementYoutubeCount(row.senderId, today);
	}

	const transcript = out.result.transcript;
	if (!transcript) {
		const note =
			out.result.note === 'transcript-quota-exceeded'
				? "Transcript budget for today is used up — try again tomorrow."
				: "Couldn't get a transcript for this video — Gemini may have refused or there's no usable audio.";
		await sendText(row.chatJid, note, config.delivery);
		pendingYoutubeButtons.delete(parsed.id);
		return;
	}

	await stripYoutubeButtons(row, '📄 Transcript sent below.');
	await sendText(
		row.chatJid,
		`*${row.title}* — full transcript:\n\n${transcript}`,
		config.delivery,
	);
	pendingYoutubeButtons.delete(parsed.id);
}

/** Build the markdown body for the saved note. Keeps the structure
 *  consistent with the LLM-composed save body — title-less (vault renderer
 *  adds the title), summary first, source link last. */
function buildSaveBody(row: PendingYoutubeRow): string {
	return [
		row.summary.trim(),
		'',
		`Source: ${row.videoUrl}`,
	].join('\n');
}

async function stripYoutubeButtons(row: PendingYoutubeRow, status: string): Promise<void> {
	try {
		await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: `${status}\n_(button tapped)_`,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow — message may already be edited or deleted */
	}
}

/** Read the YouTube config slice the same way the inbound dispatcher
 *  does (ADR-012). Keeps the settings source-of-truth in one place. */
function readYoutubeConfig() {
	const parsed = WhatsAppChannelSchema.safeParse(soulHubConfig.channels?.whatsapp ?? {});
	if (!parsed.success) return undefined;
	const yt = parsed.data.youtube;
	return { enabled: yt.enabled, maxPerDay: yt.maxPerDay, model: yt.model };
}

// ─── Intent-pattern approval keyboard (ADR-023 P1.5) ──────────────────

/** short_id → batchId. Populated by `registerIntentBatchButtons` when
 *  the analyst run sends its nudge. We don't persist this — restart loses
 *  the mapping; that's fine because the operator can also hit the
 *  `/api/intent/proposed` endpoints directly to recover. */
const pendingIntentBatches = new Map<string, { batchId: string; createdAt: number }>();

/** short_id → proposalId. Populated when [Review] fans the batch out into
 *  one message per proposal. Same restart-loss caveat as above. */
const pendingIntentProposals = new Map<
	string,
	{ proposalId: number; chatId: string | number; messageId: number; createdAt: number }
>();

/** Stable short_id derivation. Same scheme as the proposal+YouTube
 *  flows so callback_data stays ≤64 bytes. */
function shortIdForString(s: string): string {
	return createHash('sha1').update(s).digest('base64url').slice(0, 16);
}

/** Called by the learner when it sends the operator nudge — registers the
 *  mapping so callback_data can carry a compact short_id while the handler
 *  resolves it back to the real batchId. Lazy-GCs aged entries. */
export function registerIntentBatchButtons(batchId: string): string {
	const id = shortIdForString(batchId);
	pendingIntentBatches.set(id, { batchId, createdAt: Date.now() });
	const now = Date.now();
	for (const [k, v] of pendingIntentBatches) {
		if (now - v.createdAt > PENDING_TTL_MS) pendingIntentBatches.delete(k);
	}
	return id;
}

function buildIntentProposalKeyboard(proposalId: number): InlineKeyboardMarkup {
	const id = shortIdForString(`p:${proposalId}`);
	return {
		inline_keyboard: [
			[
				{ text: '✅ Approve', callback_data: `ip-yes:${id}` },
				{ text: '✗ Reject', callback_data: `ip-no:${id}` },
			],
		],
	};
}

function formatProposalForReview(row: ProposedRow): string {
	const lines = [
		`*Pattern* \`${row.signature}\` (${row.matchKind})`,
		`→ route: \`${row.pickedRoute}\`  ·  confidence: ${row.confidence.toFixed(2)}`,
	];
	if (row.placeholderText) lines.push(`bubble: "${row.placeholderText}"`);
	if (row.conversationKey) lines.push(`scope: per-user (\`${row.conversationKey.slice(0, 32)}\`)`);
	else lines.push(`scope: global`);
	if (row.rationale) lines.push(`\n${row.rationale}`);
	lines.push('');
	lines.push('*Citations:*');
	for (const c of row.citations.slice(0, 5)) {
		lines.push(`• ${c.replace(/[*_`]/g, ' ').slice(0, 200)}`);
	}
	return lines.join('\n');
}

async function handleIntentCallback(
	query: TgCallbackQuery,
	parsed: IntentParse,
	config: TelegramChannelConfig,
): Promise<void> {
	const chatId = query.message?.chat?.id;
	const messageId = query.message?.message_id;

	if (parsed.verb === 'ip-yes' || parsed.verb === 'ip-no') {
		const row = pendingIntentProposals.get(parsed.id);
		if (!row) {
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: 'Buttons expired — open /orchestration/tools to resolve manually.',
				show_alert: false,
			});
			return;
		}
		if (parsed.verb === 'ip-yes') {
			const r = promoteProposal(row.proposalId);
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: r.ok ? '✅ Approved' : `Couldn't approve: ${r.error}`,
			});
			await stripIntentButtons(row.chatId, row.messageId, r.ok ? '✅ Approved.' : `✗ ${r.error}`);
		} else {
			const r = rejectProposal(row.proposalId, 'rejected via Telegram button');
			await answerCallbackQuery({
				callback_query_id: query.id,
				text: r.ok ? '✗ Rejected' : `Couldn't reject: ${r.error}`,
			});
			await stripIntentButtons(row.chatId, row.messageId, r.ok ? '✗ Rejected.' : `✗ ${r.error}`);
		}
		pendingIntentProposals.delete(parsed.id);
		return;
	}

	// Batch-level verbs need a registered batchId.
	const batchEntry = pendingIntentBatches.get(parsed.id);
	if (!batchEntry) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Batch expired — open the proposals API to resolve manually.',
			show_alert: false,
		});
		return;
	}
	const { batchId } = batchEntry;

	if (parsed.verb === 'ip-all') {
		const r = promoteAllInBatch(batchId);
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: `✅ ${r.promoted} approved${r.skipped > 0 ? ` · ${r.skipped} skipped` : ''}`,
		});
		if (chatId !== undefined && messageId !== undefined) {
			await editMessageText({
				chat_id: chatId,
				message_id: messageId,
				text: `✅ All ${r.promoted} pattern${r.promoted === 1 ? '' : 's'} approved.`,
				parse_mode: 'Markdown',
			}).catch(() => {});
		}
		pendingIntentBatches.delete(parsed.id);
		return;
	}

	if (parsed.verb === 'ip-skip') {
		const r = deferBatch(batchId);
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: `Skipped (${r.deferred})`,
		});
		if (chatId !== undefined && messageId !== undefined) {
			await editMessageText({
				chat_id: chatId,
				message_id: messageId,
				text: `✗ Skipped — ${r.deferred} pattern${r.deferred === 1 ? '' : 's'} deferred.`,
				parse_mode: 'Markdown',
			}).catch(() => {});
		}
		pendingIntentBatches.delete(parsed.id);
		return;
	}

	// ip-review — fan out per-proposal bubbles.
	if (parsed.verb === 'ip-review') {
		const proposals = listProposed({ batchId });
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: `Sending ${proposals.length} pattern${proposals.length === 1 ? '' : 's'}…`,
		});
		if (proposals.length === 0) return;

		if (chatId === undefined) return;
		for (const p of proposals) {
			const proposalShortId = shortIdForString(`p:${p.id}`);
			const text = formatProposalForReview(p);
			const sent = await sendText(chatId, text, config.delivery, {
				replyMarkup: buildIntentProposalKeyboard(p.id),
			});
			const sentMessageId = sent.messageIds[0];
			if (sent.ok && sentMessageId !== undefined) {
				pendingIntentProposals.set(proposalShortId, {
					proposalId: p.id,
					chatId,
					messageId: sentMessageId,
					createdAt: Date.now(),
				});
			}
		}
		// Lazy GC of per-proposal map.
		const now = Date.now();
		for (const [k, v] of pendingIntentProposals) {
			if (now - v.createdAt > PENDING_TTL_MS) pendingIntentProposals.delete(k);
		}
	}
}

async function stripIntentButtons(
	chatId: string | number,
	messageId: number,
	status: string,
): Promise<void> {
	try {
		await editMessageText({
			chat_id: chatId,
			message_id: messageId,
			text: `${status}\n_(button tapped)_`,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow — message may already be edited or deleted */
	}
}

// ─── Hygiene remediation keyboard (ADR-042) ────────────────────────────

interface PendingHygieneRow {
	slug: string;
	bucket: string;
	chatJid: string;
	messageId: number;
	createdAt: number;
}

/** id → (slug, bucket) map. Restart-loss is acceptable — the next
 *  Sunday hygiene run re-emits the escalation with fresh ids. TTL is
 *  long because hygiene anomalies can sit waiting for an operator
 *  decision across several days. */
const pendingHygieneButtons = new Map<string, PendingHygieneRow>();
const HYGIENE_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Deterministic id for a (slug, bucket) pair. Same anomaly → same id
 *  across restarts; if the escalation re-fires we don't accumulate
 *  stale entries. SHA-1 truncated to fit the 64-byte callback_data cap
 *  comfortably (`hyg-arc-y:` + 16 chars = 26 bytes). */
function hygieneIdFor(slug: string, bucket: string): string {
	return createHash('sha1').update(`${slug}\0${bucket}`).digest('base64url').slice(0, 16);
}

/** Standard 3-button hygiene keyboard. Used by buckets where the
 *  remediation set is `Archive | Pause | Ignore` (archive_zone_mismatch,
 *  empty_stub, template_only_index, missing_index). Buckets needing
 *  bucket-specific verbs (Distill via scribe, Fill stub, Reconcile to
 *  X) get their own builder when those flows land. */
export function buildHygieneStandardKeyboard(
	slug: string,
	bucket: string,
): InlineKeyboardMarkup {
	const id = hygieneIdFor(slug, bucket);
	// archive_zone_mismatch's button label says "Move" since the
	// project is already status=archived; empty/template buckets need
	// "Archive" because the handler flips status first.
	const archiveLabel =
		bucket === 'archive_zone_mismatch' ? '📦 Move to archive/' : '📦 Archive now';
	return {
		inline_keyboard: [
			[
				{ text: archiveLabel, callback_data: `hyg-arc:${id}` },
				{ text: '⏸ Pause 60d', callback_data: `hyg-pause:${id}` },
			],
			[{ text: '🔇 Ignore 30d', callback_data: `hyg-ig:${id}` }],
		],
	};
}

/** Legacy export — pass-1 alias retained so any existing call sites keep
 *  working. New code uses buildHygieneStandardKeyboard. */
export const buildHygieneArchiveZoneKeyboard = buildHygieneStandardKeyboard;

/** Stash the (slug, bucket, chatJid, messageId) so the callback handler
 *  can resolve which anomaly a tap belongs to. Older entries GC'd
 *  lazily on each insert. */
export function rememberHygieneButtons(args: {
	slug: string;
	bucket: string;
	chatJid: string;
	messageId: number;
}): void {
	const id = hygieneIdFor(args.slug, args.bucket);
	pendingHygieneButtons.set(id, { ...args, createdAt: Date.now() });
	const now = Date.now();
	for (const [k, v] of pendingHygieneButtons) {
		if (now - v.createdAt > HYGIENE_PENDING_TTL_MS) pendingHygieneButtons.delete(k);
	}
}

function isoDateAddDays(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Hygiene callback branch. Five verbs, all resolved inline:
 *   - hyg-arc:    first tap → swap keyboard to confirm/cancel
 *   - hyg-arc-y:  confirmed → archiveProject() runs git mv + commit
 *   - hyg-arc-n:  cancelled → message edits to "cancelled"
 *   - hyg-pause:  setPauseUntil(slug, +60d)
 *   - hyg-ig:     suppressAnomaly(slug, bucket, 30d) */
async function handleHygieneCallback(
	query: TgCallbackQuery,
	parsed: HygieneParse,
	_config: TelegramChannelConfig,
): Promise<void> {
	const row = pendingHygieneButtons.get(parsed.id);
	if (!row) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Anomaly id expired — wait for next hygiene run',
		});
		return;
	}

	const engine = getVaultEngine();
	if (!engine) {
		await answerCallbackQuery({
			callback_query_id: query.id,
			text: 'Vault engine not ready',
		});
		return;
	}
	const vaultDir = engine.vaultDir;

	let resultText: string;

	switch (parsed.verb) {
		case 'hyg-arc': {
			// First tap — swap keyboard to confirm/cancel. No destructive op yet.
			try {
				await editMessageText({
					chat_id: row.chatJid,
					message_id: row.messageId,
					text: `Archive *${row.slug}*?\n\n\`git mv projects/${row.slug} archive/${row.slug}\``,
					parse_mode: 'Markdown',
					reply_markup: {
						inline_keyboard: [
							[
								{ text: '✅ Confirm', callback_data: `hyg-arc-y:${parsed.id}` },
								{ text: '❌ Cancel', callback_data: `hyg-arc-n:${parsed.id}` },
							],
						],
					},
				});
			} catch {
				/* edit may fail if message gone; swallow */
			}
			await answerCallbackQuery({ callback_query_id: query.id });
			return;
		}
		case 'hyg-arc-y': {
			// For empty_stub / template_only_index / missing_index, the
			// project's status is still `active`/`maintained`/etc — we need
			// to flip to `archived` first or archiveProject's status guard
			// will reject. archive_zone_mismatch already has status=archived
			// by definition; skip the flip.
			if (row.bucket !== 'archive_zone_mismatch') {
				const sR = await setProjectStatus(row.slug, 'archived', vaultDir);
				if (!sR.ok) {
					resultText = `❌ Status flip failed: ${sR.detail ?? sR.error}`;
					pendingHygieneButtons.delete(parsed.id);
					break;
				}
			}
			const r = await archiveProject(row.slug, vaultDir);
			resultText = r.ok
				? `✓ Archived \`${row.slug}\` → \`archive/${row.slug}\``
				: `❌ Archive failed: ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-arc-n': {
			resultText = `🚫 Cancelled. \`${row.slug}\` unchanged.`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-pause': {
			const date = isoDateAddDays(60);
			const r = await setPauseUntil(row.slug, date, vaultDir);
			resultText = r.ok ? `⏸ Paused \`${row.slug}\` until ${date}` : `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
		case 'hyg-ig': {
			const r = await suppressAnomaly(row.slug, row.bucket, 30);
			resultText = r.ok
				? `🔇 Ignored \`${row.slug}:${row.bucket}\` for 30 days`
				: `❌ ${r.detail ?? r.error}`;
			pendingHygieneButtons.delete(parsed.id);
			break;
		}
	}

	try {
		await editMessageText({
			chat_id: row.chatJid,
			message_id: row.messageId,
			text: resultText,
			parse_mode: 'Markdown',
		});
	} catch {
		/* swallow */
	}
	await answerCallbackQuery({ callback_query_id: query.id });
}
