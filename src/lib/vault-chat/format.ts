/** Formatter — turns the top-K hydrated notes into a markdown context
 *  block the chat LLM can read. Hard-caps total bytes so we don't blow
 *  the model's input budget on a single retrieval. */

import type { HydratedNote } from './retrieval.js';

const MAX_CONTEXT_BYTES = 3500; // ~875 tokens of context max
const PER_NOTE_BUDGET = 500; // each note gets a chunk this big before truncation

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'https://soul-hub.jneaimi.com';

/** Build the dashboard deep-link for a vault note. Goes through the same
 *  `?note=&view=note` query the `/vault` page parses on init, so a click
 *  lands directly on the note view. */
function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}

function tightExcerpt(body: string, budget: number): string {
	const trimmed = body.trim();
	if (trimmed.length <= budget) return trimmed;
	// Prefer cutting on a paragraph boundary if one falls in the back half
	// of the budget — keeps the excerpt readable rather than chopped mid-word.
	const window = trimmed.slice(0, budget);
	const para = window.lastIndexOf('\n\n');
	const cutoff = para > budget * 0.5 ? para : budget;
	return window.slice(0, cutoff).trimEnd() + '…';
}

function formatNote(note: HydratedNote, idx: number, budget: number): string {
	const meta: string[] = [];
	if (note.type) meta.push(`type: ${note.type}`);
	if (note.project) meta.push(`project: ${note.project}`);
	if (note.tags && note.tags.length) meta.push(`tags: ${note.tags.slice(0, 5).join(', ')}`);
	if (note.updated) meta.push(`updated: ${note.updated}`);
	else if (note.created) meta.push(`created: ${note.created}`);

	const header = `### ${idx + 1}. ${note.title}`;
	const path = `_path: \`${note.path}\` · via ${note.source}_`;
	const open = `_open: ${noteOpenUrl(note.path)}_`;
	const metaLine = meta.length ? `- ${meta.join(' · ')}` : '';
	const fixedSize = header.length + path.length + open.length + metaLine.length + 8; // newlines
	const bodyBudget = Math.max(80, budget - fixedSize);
	const excerpt = tightExcerpt(note.body, bodyBudget);

	return [header, metaLine, path, open, '', excerpt].filter(Boolean).join('\n');
}

export function formatContextBlock(notes: HydratedNote[]): string {
	if (notes.length === 0) return '';

	const blocks: string[] = [];
	let used = 0;
	for (let i = 0; i < notes.length; i++) {
		const remaining = MAX_CONTEXT_BYTES - used;
		if (remaining < 200) break;
		const budget = Math.min(PER_NOTE_BUDGET, remaining);
		const block = formatNote(notes[i], i, budget);
		blocks.push(block);
		used += block.length + 2; // +2 for the joining newlines
	}

	return blocks.join('\n\n');
}

const SYSTEM_PREAMBLE = `You answer questions about the Soul Hub vault using the context below. The context is the top-ranked notes from a lexical search over the vault — title, path, tags, an open URL, and an excerpt of each note's body.

Rules:
- Ground every claim in the context. If something isn't in it, say "I don't see that in the vault" rather than guessing.
- When you reference a note, append its open URL on the same line (or right after) so the user can tap it. Format: \`<note title or path> — <url>\`. Use the URL exactly as given in the context's \`open:\` line. WhatsApp does not render markdown links, so put the bare URL inline.
- Be concise. WhatsApp messages must fit comfortably in a phone screen — aim for a short paragraph or a tight bullet list, not a full report.
- If the context is empty or irrelevant, say so honestly and suggest the user refine the question (mention a project, a tag, or a date).
- Reply in the same language the user wrote in (English or Arabic).`;

export function buildSystemPrompt(contextBlock: string): string {
	if (!contextBlock) {
		return `${SYSTEM_PREAMBLE}\n\n## Vault Context\n\n_(no relevant notes found — answer honestly that nothing matched)_`;
	}
	return `${SYSTEM_PREAMBLE}\n\n## Vault Context\n\n${contextBlock}`;
}
