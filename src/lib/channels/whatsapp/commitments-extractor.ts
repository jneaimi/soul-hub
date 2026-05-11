/** Slice 5 — inferred commitments. Hidden Flash extraction that runs
 *  after every meaningful WhatsApp exchange and spots conversation-bound
 *  follow-ups ("interview tomorrow" → check in afterward). Below the
 *  configured confidence threshold the extracted commitment is dropped
 *  without storage; above, it's persisted scoped to (channel, target)
 *  and the heartbeat composer surfaces it when due.
 *
 *  Fire-and-forget: dispatch.ts kicks this off via `setImmediate` after
 *  the user already has their reply, so no extraction failure can block
 *  or slow the chat. Errors are logged and swallowed.
 *
 *  Structured output uses the flat-enum + `.describe()` per-field pattern
 *  per `feedback_ai_sdk_v6_structured_output` — Zod discriminated unions
 *  break Gemini controlled-generation. */

import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import { parseProviderRef } from '../../llm/types.js';
import { insertCommitment } from './heartbeat-state.js';

const CommitmentSchema = z.object({
	suggested_text: z
		.string()
		.describe(
			'A short natural-language follow-up the agent could send later, written in second person ("How did your interview go?"). Empty string when nothing extractable.',
		),
	hours_until_due: z
		.number()
		.min(0)
		.max(168)
		.describe(
			'Hours from now until this follow-up becomes relevant. 1 = soon, 24 = tomorrow, 168 = a week. 0 means the message is too immediate to track as a commitment.',
		),
	confidence: z
		.number()
		.min(0)
		.max(1)
		.describe(
			'How confident you are that this is a real conversation-bound commitment worth tracking. 0 = clearly not, 1 = certainty. Below 0.7 means probably skip.',
		),
});

const ExtractionSchema = z.object({
	commitments: z
		.array(CommitmentSchema)
		.describe(
			'List of inferred follow-ups. Empty array when the exchange has no commitment-worthy content (most exchanges).',
		),
});

const SYSTEM_PROMPT = `You read a single WhatsApp exchange and decide whether it implies a follow-up the agent should remember.

Rules:
- Only extract commitments tied to a future event the user mentioned ("I have an interview tomorrow", "I'm flying out Friday", "I'll know by next week").
- Skip rhetorical statements, questions, and generic chitchat.
- Skip explicit reminders ("remind me at 3pm") — those are handled by a different system.
- Each commitment must have a clear time horizon (hours_until_due) and a natural follow-up text.
- Set confidence honestly — if you're guessing, score below 0.7 and the system will drop it.
- Most exchanges produce zero commitments. That's the right answer when nothing surfaces.`;

function readChannelConfig() {
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export interface ExtractInput {
	channel: 'whatsapp';
	target: string;
	userText: string;
	agentReply: string;
	sourceMsgId: string | null;
}

/** Run the extraction. Returns the count of commitments inserted (>=0).
 *  Throws only on config/setup errors; extraction failures are caught
 *  and logged so the caller can fire-and-forget without `.catch()`. */
export async function extractCommitments(input: ExtractInput): Promise<number> {
	const cfg = readChannelConfig();
	if (!cfg) return 0;
	const cm = cfg.commitments;
	if (!cm.enabled) return 0;
	if (!input.userText.trim() || !input.agentReply.trim()) return 0;

	const { providerId, modelId } = parseProviderRef(cm.extractionModel);
	if (providerId !== 'gemini') {
		// Other providers will be wired alongside heartbeat.callModel; same gate.
		console.warn(
			`[whatsapp/commitments] extractor only supports gemini for now; got "${providerId}". Skipping.`,
		);
		return 0;
	}

	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.warn('[whatsapp/commitments] GEMINI_API_KEY not set — extractor disabled.');
		return 0;
	}

	const client = createGoogleGenerativeAI({ apiKey });

	let extraction: z.infer<typeof ExtractionSchema>;
	try {
		const result = await generateText({
			model: client(modelId),
			system: SYSTEM_PROMPT,
			output: Output.object({ schema: ExtractionSchema }),
			prompt: `User: ${input.userText}\n\nAgent: ${input.agentReply}`,
			maxOutputTokens: 600,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
		});
		extraction = result.output;
	} catch (err) {
		console.warn('[whatsapp/commitments] extraction failed:', (err as Error).message);
		return 0;
	}

	const minIntervalMs = 60 * 60 * 1000; // floor of 1h between extraction and due — matches dueDelayHours min
	const dueDelayMs = Math.max(cm.dueDelayHours * 60 * 60 * 1000, minIntervalMs);

	let inserted = 0;
	for (const commitment of extraction.commitments) {
		if (commitment.confidence < cm.confidenceThreshold) continue;
		if (!commitment.suggested_text.trim()) continue;
		if (commitment.hours_until_due <= 0) continue;

		const dueAfterTs =
			Date.now() + Math.max(commitment.hours_until_due * 60 * 60 * 1000, dueDelayMs);

		try {
			insertCommitment({
				channel: input.channel,
				target: input.target,
				suggestedText: commitment.suggested_text.trim(),
				dueAfterTs,
				sourceMsgId: input.sourceMsgId,
				confidence: commitment.confidence,
				source: 'extractor',
			});
			inserted++;
		} catch (err) {
			console.warn('[whatsapp/commitments] insert failed:', (err as Error).message);
		}
	}

	if (inserted > 0) {
		console.log(`[whatsapp/commitments] inserted ${inserted} commitment(s) for ${input.target}`);
	}
	return inserted;
}

/** Fire-and-forget wrapper — never throws, never awaited. Use this from
 *  the dispatcher right after a successful reply so commitment extraction
 *  doesn't block the user. */
export function extractCommitmentsAsync(input: ExtractInput): void {
	setImmediate(() => {
		void extractCommitments(input).catch((err) => {
			console.warn('[whatsapp/commitments] background extraction errored:', (err as Error).message);
		});
	});
}
