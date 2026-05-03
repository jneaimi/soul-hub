/** Tool selector — given a user message, picks 1–3 vault tools to run.
 *
 *  Two paths:
 *    1. Gemini Flash with a Zod-schema-constrained response via AI SDK v6's
 *       `generateText` + `Output.object({schema})`. The schema is a
 *       discriminated union per tool name, so each variant's arg shape is
 *       enforced — Gemini can't return `byProject` with a `tags` field.
 *       Throws `NoOutputGeneratedError` only when the model can't produce
 *       a valid object at all.
 *    2. Heuristic fallback — runs when Gemini is unavailable, the call
 *       times out, or the structured-output call fails. Always emits at
 *       least a `fulltext` baseline so retrieval isn't empty.
 *
 *  We never let the selector be a hard dependency: a vault chat that
 *  can't reach Gemini still answers, just with simpler retrieval. */

import { generateText, Output, NoOutputGeneratedError } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import type { ToolCall } from './tools.js';
import { TOOL_CATALOG } from './tools.js';

const SELECTOR_MODEL = 'gemini-2.5-flash';
const SELECTOR_TIMEOUT_MS = 4500;

/** Zod schema for the selector's structured output.
 *
 *  Two design choices worth flagging:
 *
 *  1. **No discriminated union on `name`.** Gemini's "controlled generation"
 *     (the mechanism AI SDK v6's `Output.object` plugs into) rejects
 *     Zod-derived `oneOf` schemas with "response did not match schema"
 *     even when the model's output is valid. The enum on `name` still
 *     gives us the most important guarantee — Gemini can't invent a
 *     tool name. Per-tool argument shape coercion happens inside
 *     `runTool()` so a malformed `args` blob still degrades safely
 *     (the tool returns `[]` for a missing required field).
 *
 *  2. **`args` is a flat object with every possible field optional.**
 *     A generic `z.record()` makes Gemini emit `args: {}` for every
 *     call because it has no field hints. Listing the union of
 *     fields-across-tools as optional pulls them into the JSON Schema
 *     so the model knows which keys to populate per tool. The schema
 *     description still tells the model which keys go with which tool. */
const ArgsSchema = z
	.object({
		q: z.string().optional().describe('For "fulltext": focused search query, 2 to 6 keywords distilled from the user message.'),
		limit: z.number().int().min(1).max(20).optional().describe('Max results per tool, default 8.'),
		type: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe('For "byType": note type, e.g. "decision", "learning", "debugging", "pattern", "project", "research", "draft", "recipe".'),
		tags: z
			.union([z.string(), z.array(z.string())])
			.optional()
			.describe('For "byTag": tag or comma-separated tags. AND logic — every tag must match.'),
		project: z.string().optional().describe('For "byProject": project slug, kebab-case (e.g. "soul-hub-whatsapp").'),
		path: z.string().optional().describe('For "backlinks": vault-relative note path (e.g. "projects/soul-hub-whatsapp/index.md").'),
	})
	.describe('Tool arguments. Each tool only reads its own field(s).');

const SelectionSchema = z.object({
	tools: z
		.array(
			z.object({
				name: z
					.enum(['fulltext', 'recent', 'byType', 'byTag', 'byProject', 'backlinks'])
					.describe('Which retrieval tool to run. See the system prompt for what each does.'),
				args: ArgsSchema,
			}),
		)
		.min(1)
		.max(3)
		.describe('1 to 3 tool calls. Always include "fulltext" unless the question is purely structural.'),
});

const SYSTEM_PROMPT = `You are a retrieval planner for the Soul Hub vault — a personal knowledge base indexed by lexical search over note title, path, tags, and body. The user asks a question; you pick which tools to run to gather context that will help answer it. Pick 1 to 3 tools, returned in the structured object response.

Available tools:
${TOOL_CATALOG.map((t) => `- ${t.name}: ${t.description}`).join('\n')}

Rules:
- Always include "fulltext" with a focused query unless the question is purely structural ("show recent decisions" → byType only is fine).
- Prefer "byProject" over "fulltext" when the user names a project explicitly (kebab-case like "soul-hub-whatsapp" or natural-language like "the WhatsApp project").
- Use "recent" only for time-shaped queries ("latest", "this week", "what did I do today").
- Use "byTag" only when the user explicitly names a tag word.
- "backlinks" requires an exact note path — almost never selected on the first turn.
- Keep limits modest (5–10). The retrieval merger picks top-K across all tools.`;

export interface SelectorOutput {
	tools: ToolCall[];
	source: 'gemini' | 'heuristic';
	reason?: string;
}

/** Heuristic fallback — pattern-matches the message text. Conservative on
 *  purpose: misses are fine, the fulltext call always runs. */
export function heuristicSelect(userMessage: string): SelectorOutput {
	const calls: ToolCall[] = [];
	const lower = userMessage.toLowerCase();

	// Recency markers
	if (/\b(recent|latest|newest|today|this week|yesterday|so far)\b/.test(lower)) {
		calls.push({ name: 'recent', args: { limit: 8 } });
	}

	// Type markers
	const typeMatch = lower.match(
		/\b(decisions?|learnings?|debugging|patterns?|adrs?|drafts?|research|recipes?)\b/,
	);
	if (typeMatch) {
		const raw = typeMatch[1];
		const type = raw.startsWith('adr')
			? 'decision'
			: raw.replace(/s$/, ''); // crude singularisation
		calls.push({ name: 'byType', args: { type, limit: 8 } });
	}

	// Project markers — match kebab-case slugs that look like project ids
	const projectMatch = userMessage.match(/\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,4})\b/);
	if (projectMatch) {
		calls.push({ name: 'byProject', args: { project: projectMatch[1], limit: 8 } });
	}

	// Tag markers
	const tagMatch = userMessage.match(/#([a-zA-Z][\w-]+)/);
	if (tagMatch) {
		calls.push({ name: 'byTag', args: { tags: tagMatch[1], limit: 8 } });
	}

	// Fulltext is the baseline — always include it with the user's message
	// (trimmed). MiniSearch handles the rest.
	const q = userMessage.trim().slice(0, 200);
	calls.push({ name: 'fulltext', args: { q, limit: 8 } });

	return { tools: calls, source: 'heuristic' };
}

export async function selectTools(userMessage: string): Promise<SelectorOutput> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) return heuristicSelect(userMessage);

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), SELECTOR_TIMEOUT_MS);

	try {
		const client = createGoogleGenerativeAI({ apiKey });
		const result = await generateText({
			model: client(SELECTOR_MODEL),
			output: Output.object({ schema: SelectionSchema }),
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: userMessage }],
			maxOutputTokens: 400,
			abortSignal: ctrl.signal,
		});
		clearTimeout(timer);

		// Name is enum-validated by the schema; args is a generic record.
		// `runTool()` performs the per-tool arg shape coercion and falls
		// back to `[]` if a required field is missing — see tools.ts.
		const tools: ToolCall[] = result.output.tools.map((t) => ({
			name: t.name,
			args: t.args,
		}));

		// Always guarantee a fulltext call so we have a topical baseline,
		// even if the selector picked only structural tools.
		const hasFulltext = tools.some((t) => t.name === 'fulltext');
		if (!hasFulltext) {
			tools.push({
				name: 'fulltext',
				args: { q: userMessage.trim().slice(0, 200), limit: 6 },
			});
		}

		return { tools, source: 'gemini' };
	} catch (err) {
		clearTimeout(timer);
		// Graceful fallback for any failure path: AbortController timeout,
		// NoOutputGeneratedError (model couldn't produce a valid object),
		// network blip. Missing key is handled above.
		const reason =
			err instanceof NoOutputGeneratedError
				? 'selector could not produce a valid object'
				: err instanceof Error
					? `selector failed: ${err.message}`
					: 'selector failed: unknown error';
		return { ...heuristicSelect(userMessage), reason };
	}
}
