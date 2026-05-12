/**
 * Layer 3 Stage 4 — `inbox-route-to-vault` (ADR 2026-05-11-inbox-agent-workflows-layer-3 §D5).
 *
 * Takes a queued inbox message and persists it to the vault as a markdown
 * note. Composes the note body from the cached `extracted_data` plus a
 * short body excerpt, picks tags per-category, calls `dispatchVaultSave`,
 * and on success marks the message processed.
 *
 * Worker-driven only in v1 — the periodic auto-route worker
 * (`auto-route.ts`) invokes this against rows that match the operator's
 * per-category rules. NOT exposed to the orchestrator-v2 chat surface
 * because:
 *   (a) manual "save this email" already works via vaultSearch +
 *       vaultSave composition, and
 *   (b) S4's auto-route is the only Layer 3 surface that auto-acts; it
 *       deserves the operator-toggle gate from settings.json, not an
 *       LLM-pickable tool that could fire ungated.
 *
 * Audit: every invocation writes an `agent_actions` row (Guardrail 2)
 * with `result.vaultPath` so the operator can answer "what vault note
 * did the agent create from msg N?" without a vault lookup.
 */

import type { InboxMessage, TransactionalExtract } from './types.js';
import { getMessage, markMessageProcessed, recordAgentAction } from './db.js';
import { getExtractedData } from './db.js';
import { dispatchVaultSave } from '../vault-save/index.js';
import type { VaultSaveType } from '../vault-save/index.js';

export interface RouteToVaultResult {
	ok: boolean;
	messageId: number;
	vaultPath?: string;
	openUrl?: string;
	noteTitle?: string;
	error?: string;
	/** Why the worker picked this message — e.g. 'transactional.receipt.over-threshold'. */
	reason?: string;
}

export interface RouteToVaultOptions {
	/** Operator who initiated. 'worker' for auto-route; reserve 'operator-direct'
	 *  for a future chat-tool variant. Mirrors the agent_actions schema. */
	actor: 'worker' | 'operator-direct';
	/** Match rule string for audit (e.g. 'receipts.amount>50'). Optional. */
	reason?: string;
}

/** Route one message to vault. Returns success/failure; never throws.
 *  Caller (auto-route worker) iterates over candidates and aggregates. */
export async function routeMessageToVault(
	messageId: number,
	options: RouteToVaultOptions = { actor: 'worker' },
): Promise<RouteToVaultResult> {
	const message = getMessage(messageId);
	if (!message) {
		const result: RouteToVaultResult = {
			ok: false,
			messageId,
			error: 'message not found',
		};
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: options.actor,
			args: { reason: options.reason },
			result,
		});
		return result;
	}

	if (message.processStatus === 'processed') {
		// Idempotency — already routed by a prior tick.
		return {
			ok: true,
			messageId,
			reason: 'already-processed',
		};
	}

	const extract = parseExtractedData(message);
	const composed = composeNote(message, extract);

	try {
		const saveResult = await dispatchVaultSave({
			title: composed.title,
			content: composed.body,
			type: composed.type,
			tags: composed.tags,
		});

		if (!saveResult.ok) {
			const result: RouteToVaultResult = {
				ok: false,
				messageId,
				error: `vault save failed: ${saveResult.error}`,
				reason: options.reason,
			};
			recordAgentAction({
				tool: 'inbox-route-to-vault',
				messageId,
				actor: options.actor,
				args: { reason: options.reason },
				result,
			});
			return result;
		}

		// Mark processed only after successful vault save. If this fails,
		// the row stays queued — the next tick will retry. Idempotency
		// above prevents duplicate vault notes (the second pass returns
		// 'already-processed' before reaching the save).
		try {
			markMessageProcessed(messageId);
		} catch (err) {
			console.warn(
				`[inbox-route-to-vault] markMessageProcessed(${messageId}) failed after save: ${(err as Error).message}`,
			);
		}

		const result: RouteToVaultResult = {
			ok: true,
			messageId,
			vaultPath: saveResult.path,
			openUrl: saveResult.openUrl,
			noteTitle: saveResult.title,
			reason: options.reason,
		};
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: options.actor,
			args: { reason: options.reason },
			result,
		});
		return result;
	} catch (err) {
		const result: RouteToVaultResult = {
			ok: false,
			messageId,
			error: (err as Error).message,
			reason: options.reason,
		};
		recordAgentAction({
			tool: 'inbox-route-to-vault',
			messageId,
			actor: options.actor,
			args: { reason: options.reason },
			result,
		});
		return result;
	}
}

interface ComposedNote {
	title: string;
	body: string;
	type: VaultSaveType;
	tags: string[];
}

/** Compose the markdown body per category. Receipt/payment surface the
 *  amount + merchant + ref number in the body; shipping surfaces the
 *  carrier/tracking-adjacent metadata if we have it; service-alerts
 *  surface the from-address as the "issuer". All categories include the
 *  500-char body preview as the source text. */
function composeNote(message: InboxMessage, extract: TransactionalExtract | null): ComposedNote {
	const fromLabel = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
	const subject = message.subject || '(no subject)';
	const receivedIso = new Date(message.dateReceived).toISOString();

	const tags = new Set<string>(['inbox-auto-route']);
	if (message.category) tags.add(message.category);
	if (extract?.kind && extract.kind !== 'unknown') tags.add(extract.kind);

	let title: string;
	let header: string[];

	if (message.category === 'transactional' && extract?.kind === 'receipt') {
		const merchant = extract.merchant || 'Unknown merchant';
		const amountLabel = formatAmount(extract.amount, extract.currency);
		title = amountLabel ? `Receipt — ${merchant} (${amountLabel})` : `Receipt — ${merchant}`;
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'payment') {
		const merchant = extract.merchant || 'Unknown merchant';
		const amountLabel = formatAmount(extract.amount, extract.currency);
		title = amountLabel ? `Payment — ${merchant} (${amountLabel})` : `Payment — ${merchant}`;
		header = transactionalHeader(extract, fromLabel, receivedIso);
		if (extract.merchant) tags.add(slugTag(extract.merchant));
	} else if (message.category === 'transactional' && extract?.kind === 'alert') {
		title = `Security alert — ${shortenSubject(subject)}`;
		header = transactionalHeader(extract, fromLabel, receivedIso);
		tags.add('security');
	} else if (message.category === 'notification') {
		// Shipping is the headline notification subtype we auto-route.
		title = `Shipping — ${shortenSubject(subject)}`;
		header = [
			`**From:** ${fromLabel}`,
			`**Received:** ${receivedIso}`,
			`**Subject:** ${subject}`,
		];
		tags.add('shipping');
	} else {
		// Fallback — covers any category that slipped past the rule check.
		title = shortenSubject(subject);
		header = [
			`**From:** ${fromLabel}`,
			`**Received:** ${receivedIso}`,
			`**Subject:** ${subject}`,
		];
	}

	const preview = (message.bodyPreview || '').trim();
	const body = [
		...header,
		'',
		'---',
		'',
		'## Body preview',
		'',
		preview || '_(no preview available)_',
		'',
		`_Auto-routed from inbox msg ${message.id} on ${receivedIso}_`,
	].join('\n');

	// 'reference' fits transactional rows (these are records of past events).
	// 'draft' fits notification (more ephemeral). We use 'reference' across
	// the board for v1 — the vault zone is `inbox/` either way, and the
	// `type` only affects validators downstream.
	return {
		title,
		body,
		type: 'reference',
		tags: [...tags],
	};
}

function transactionalHeader(
	extract: TransactionalExtract,
	fromLabel: string,
	receivedIso: string,
): string[] {
	const lines = [`**From:** ${fromLabel}`, `**Received:** ${receivedIso}`];
	if (extract.merchant) lines.push(`**Merchant:** ${extract.merchant}`);
	const amountLabel = formatAmount(extract.amount, extract.currency);
	if (amountLabel) lines.push(`**Amount:** ${amountLabel}`);
	if (extract.cardLast4) lines.push(`**Card:** ••${extract.cardLast4}`);
	if (extract.date) lines.push(`**Date:** ${extract.date}`);
	if (extract.referenceNumber) lines.push(`**Reference:** \`${extract.referenceNumber}\``);
	if (extract.anomalyHint) lines.push(`**Anomaly hint:** yes`);
	return lines;
}

function formatAmount(amount: number | undefined, currency: string | undefined): string | null {
	if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
	const cur = (currency || '').trim().toUpperCase();
	return cur ? `${cur} ${amount.toFixed(2)}` : amount.toFixed(2);
}

function shortenSubject(subject: string): string {
	const trimmed = subject.replace(/\s+/g, ' ').trim();
	return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 77) + '…';
}

function slugTag(input: string): string {
	return input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function parseExtractedData(message: InboxMessage): TransactionalExtract | null {
	if (!message.extractedData) return null;
	try {
		const parsed = JSON.parse(message.extractedData) as TransactionalExtract;
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}
