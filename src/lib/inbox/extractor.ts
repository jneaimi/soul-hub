/** Layer 3 Stage 2 — structured extraction for transactional mail.
 *  See ADR 2026-05-11-inbox-agent-workflows-layer-3 §D3.
 *
 *  Pulls `{kind, amount, currency, merchant, date, cardLast4,
 *  referenceNumber, anomalyHint, note}` from a queued transactional
 *  message. Lazy by default — only runs when `inbox-extract-data` asks.
 *  Result is cached on the message row so subsequent queries are free.
 *
 *  Privacy: extractor runs on `subject + body_preview` ONLY in v1
 *  (per ADR §Privacy "envelope + preview by default"). Body fetches are
 *  reserved for `inbox-read-body` and are not invoked here.
 *
 *  Failure handling: a non-parseable LLM response, schema validation
 *  failure, or LLM error caches `{kind:'unknown', note:'<reason>'}` so
 *  the calling tool returns cleanly AND a retry loop is structurally
 *  impossible — the next call sees the cached failure and short-circuits.
 *
 *  Pattern mirrors `commitments-extractor.ts`: `generateText` +
 *  `Output.object()` per the feedback_ai_sdk_v6_structured_output rule
 *  (flat enum + `.describe()` per field; no discriminated unions). */

import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

import type { InboxMessage } from './types.js';

const TRANSACTIONAL_KINDS = [
	'payment',
	'refund',
	'receipt',
	'otp',
	'alert',
	'subscription-renewal',
	'unknown',
] as const;
export type TransactionalKind = (typeof TRANSACTIONAL_KINDS)[number];

export interface TransactionalExtract {
	kind: TransactionalKind;
	amount?: number;
	currency?: string;
	merchant?: string;
	/** ISO date when the transaction occurred (NOT when mail arrived). */
	date?: string;
	cardLast4?: string;
	referenceNumber?: string;
	/** Heuristic anomaly signal — LLM flags unusual / over-threshold language.
	 *  Stage 3's heartbeat anomaly push reads this to decide push-now vs
	 *  daily-batch. */
	anomalyHint?: boolean;
	/** Free-form note when the row doesn't fit the shape (e.g. failure
	 *  reason cached as `{kind:'unknown', note:'<reason>'}`). */
	note?: string;
}

const TransactionalExtractSchema = z.object({
	kind: z
		.enum(TRANSACTIONAL_KINDS)
		.describe(
			'Best-fit category for this transactional mail. "payment" = money left your account. "refund" = money returned. "receipt" = purchase confirmation. "otp" = one-time-password / verification code. "alert" = security or fraud alert. "subscription-renewal" = recurring charge confirmation. "unknown" when the shape does not fit.',
		),
	amount: z
		.number()
		.describe(
			'Numeric amount of the transaction (e.g. 45.00). Use 0 if no amount is present (e.g. OTP, security alert without a charge).',
		),
	currency: z
		.string()
		.describe(
			'ISO currency code in upper-case, e.g. "AED", "USD", "EUR". Empty string when no currency is present.',
		),
	merchant: z
		.string()
		.describe(
			'The merchant, sender bank, or service that issued the transaction (e.g. "Carrefour", "Apple", "Emirates NBD"). Empty string when not identifiable.',
		),
	date: z
		.string()
		.describe(
			'ISO 8601 date (YYYY-MM-DD) when the transaction occurred — NOT when the email arrived. Empty string when no transaction date is in the message.',
		),
	cardLast4: z
		.string()
		.describe(
			'Last 4 digits of the card or account, when present. Empty string when not in the message.',
		),
	referenceNumber: z
		.string()
		.describe(
			'Bank reference, order number, OTP code, or invoice ID when present. Empty string otherwise.',
		),
	anomalyHint: z
		.boolean()
		.describe(
			'TRUE only when the message contains explicit unusual-activity language ("unusual sign-in", "exceeded limit", "fraud", "suspicious"). FALSE for routine transactions even if large.',
		),
	note: z
		.string()
		.describe(
			'A short free-form note when the message does not cleanly fit the shape — e.g. "promotional mail mis-classified" or "transaction declined". Empty string when extraction was clean.',
		),
});

const SYSTEM_PROMPT = `You read a single transactional email (subject + 500-character preview) and extract a structured JSON record.

Rules:
- Output strictly matches the schema. Use empty strings for missing string fields and 0 for missing amounts — do not invent values.
- Pick exactly one \`kind\`. Use "unknown" when no category fits.
- ISO date format only (YYYY-MM-DD). Parse "12 May 2026", "May 12", "2026-05-12" — but skip ambiguous "5/12" without a year.
- \`anomalyHint\` is strict: set TRUE only when the email itself flags unusual activity ("unusual sign-in", "exceeded", "fraud", "suspicious", "verify it was you"). A large but routine transaction is NOT anomalous.
- The preview is truncated to ~500 chars. If a field is genuinely missing from the preview, leave it empty — do not guess. The caller may re-extract from the full body later.`;

export interface ExtractInput {
	subject: string;
	preview: string;
}

export interface ExtractResult {
	ok: boolean;
	extract: TransactionalExtract;
	/** When `ok=false`, the reason is also written into `extract.note`. */
	reason?: string;
}

/** Run the extractor on a single transactional message. Always returns —
 *  failures resolve to `{ok:false, extract:{kind:'unknown',note:<reason>}}`
 *  so the caller can cache the result and short-circuit retries.
 *
 *  Returns a plain result; persistence is the caller's job (so the same
 *  function can be exercised in tests without touching the DB). */
export async function extractTransactional(input: ExtractInput): Promise<ExtractResult> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		const reason = 'GEMINI_API_KEY not set';
		return { ok: false, reason, extract: { kind: 'unknown', note: reason } };
	}

	const subject = (input.subject || '').slice(0, 200);
	const preview = (input.preview || '').slice(0, 500);
	if (!subject.trim() && !preview.trim()) {
		const reason = 'empty subject and preview';
		return { ok: false, reason, extract: { kind: 'unknown', note: reason } };
	}

	const client = createGoogleGenerativeAI({ apiKey });
	const modelId = process.env.INBOX_EXTRACT_MODEL || 'gemini-2.5-flash';

	let raw: z.infer<typeof TransactionalExtractSchema>;
	try {
		const result = await generateText({
			model: client(modelId),
			system: SYSTEM_PROMPT,
			output: Output.object({ schema: TransactionalExtractSchema }),
			prompt: `Subject: ${subject}\n\nPreview: ${preview}`,
			maxOutputTokens: 400,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
		});
		raw = result.output;
	} catch (err) {
		const reason = `extractor LLM error: ${(err as Error).message}`;
		return { ok: false, reason, extract: { kind: 'unknown', note: reason } };
	}

	// Normalise the flat-string output into the optional-field
	// TransactionalExtract shape — drop empties so cached JSON stays tight.
	const extract: TransactionalExtract = { kind: raw.kind };
	if (raw.amount > 0) extract.amount = raw.amount;
	if (raw.currency.trim()) extract.currency = raw.currency.trim().toUpperCase();
	if (raw.merchant.trim()) extract.merchant = raw.merchant.trim();
	if (raw.date.trim()) extract.date = raw.date.trim();
	if (raw.cardLast4.trim()) extract.cardLast4 = raw.cardLast4.trim();
	if (raw.referenceNumber.trim()) extract.referenceNumber = raw.referenceNumber.trim();
	if (raw.anomalyHint) extract.anomalyHint = true;
	if (raw.note.trim()) extract.note = raw.note.trim();

	return { ok: true, extract };
}

/** Helper for the orchestrator tool — given an `InboxMessage`, returns
 *  the inputs the extractor needs. Centralised here so the tool stays
 *  thin and tests can construct inputs from fixture rows directly. */
export function inputFromMessage(msg: InboxMessage): ExtractInput {
	return { subject: msg.subject, preview: msg.bodyPreview };
}
