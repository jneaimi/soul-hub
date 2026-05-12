/**
 * vaultSave — thin wrapper around `engine.createNote()` for the
 * orchestrator-v2 `vaultSave` tool (ADR-013).
 *
 * Differs from `src/lib/vault-actions/save.ts` (which is the WhatsApp `/save`
 * slash-command handler): this module takes already-synthesized fields
 * from the orchestrator LLM (title, content, type, tags, sourceUrl) and
 * writes a vault note. No multimodal extraction, no envelope coupling,
 * no Gemini call. The LLM has done the synthesis upstream — this just
 * persists it.
 *
 * Always writes to `inbox/` so the user curates later. Filename is
 * `YYYY-MM-DD-${slug}.md` matching vault-actions/save.ts conventions so the
 * vault watcher and graph treat them uniformly.
 */

import { getVaultEngine } from '../vault/index.js';

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'https://soul-hub.jneaimi.com';
const AGENT = 'orchestrator-v2-vaultSave';
const INBOX_ZONE = 'inbox';

export type VaultSaveType = 'draft' | 'reference' | 'learning' | 'idea';

export interface VaultSaveInput {
	title: string;
	content: string;
	/** Note type. `idea` maps to `draft + tag:idea` because the inbox zone's
	 *  governance allowlist doesn't include `idea` as a type — same trick
	 *  vault-actions/save.ts uses for the `idea: foo` prefix. */
	type?: VaultSaveType;
	tags?: string[];
	/** When the saved content was derived from a URL (e.g., YouTube), pass
	 *  it here — lands in `meta.source` for back-tracking. */
	sourceUrl?: string;
	/** Channel that triggered the save — added as a tag for filterability.
	 *  Optional because non-channel callers (debug, tests) shouldn't have
	 *  to fake it. */
	channel?: 'whatsapp' | 'telegram' | 'web';
}

export type VaultSaveOutcome =
	| { ok: true; path: string; openUrl: string; title: string }
	| { ok: false; error: string; title: string };

export async function dispatchVaultSave(input: VaultSaveInput): Promise<VaultSaveOutcome> {
	const engine = getVaultEngine();
	if (!engine) {
		return { ok: false, error: 'Vault is not initialized', title: input.title };
	}

	const today = new Date().toISOString().slice(0, 10);

	// `idea` is a tag, not a type — see vault-actions/save.ts:159 for the same
	// inbox-governance dance.
	const requestedType = input.type ?? 'draft';
	const isIdea = requestedType === 'idea';
	const finalType = isIdea ? 'draft' : requestedType;

	const slug = slugify(input.title);
	const filename = `${today}-${slug}.md`;

	const tags = new Set<string>();
	if (isIdea) tags.add('idea');
	if (input.channel) tags.add(input.channel);
	for (const t of input.tags ?? []) {
		const cleaned = t.toLowerCase().replace(/^#/, '').trim();
		if (cleaned) tags.add(cleaned);
	}

	const meta: Record<string, unknown> = {
		type: finalType,
		created: today,
		tags: [...tags],
		source_agent: AGENT,
	};
	if (input.sourceUrl) meta.source = input.sourceUrl;

	const result = await engine.createNote({
		zone: INBOX_ZONE,
		filename,
		meta,
		content: input.content.trim(),
	});

	if (!result.success) {
		return { ok: false, error: result.error, title: input.title };
	}

	return {
		ok: true,
		path: result.path,
		openUrl: noteOpenUrl(result.path),
		title: input.title,
	};
}

/** Slug a string into a filesystem-safe filename stem. Mirrors
 *  vault-actions/save.ts:142 so notes from both surfaces sort identically.
 *  Falls back to `note` when normalization strips everything. */
function slugify(input: string): string {
	const normalized = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '') // strip combining marks
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	const truncated = normalized.slice(0, 60).replace(/-+$/, '');
	return truncated || 'note';
}

function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}
