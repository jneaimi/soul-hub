/** ADR-043 — Broken-wikilink remediation actions (pilot bucket).
 *
 *  Pure functions that mutate a single note to remove a broken
 *  wikilink. Called from the Telegram callback handler when the
 *  operator taps `🗑 Unlink` on a `vh-unlink` button.
 *
 *  The vault-hygiene engine surfaces broken wikilinks as
 *  `UnresolvedIssue` entries: `{source, raw, suggestedFix}` where
 *  `source` is the note containing the broken link and `raw` is the
 *  literal `[[target]]` or `[[target|alias]]` markdown.
 *
 *  Unlink rewrites that ONE wikilink to its display text (alias if
 *  present, else the last segment of the target path). All other
 *  prose stays intact. Other occurrences of the same literal in the
 *  file are also rewritten — same broken target shouldn't survive
 *  in any form once the operator decides to drop it. The vault
 *  watcher commits the write naturally; no explicit git op here.
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export interface LinkActionResult {
	ok: boolean;
	error?: string;
	detail?: string;
}

/** Default display text for a wikilink target with no alias.
 *  `path/to/slug` → "slug", `slug#heading` → "slug". */
export function defaultDisplayFor(target: string): string {
	const lastSeg = target.split('/').pop() ?? target;
	const noAnchor = lastSeg.split('#')[0];
	return noAnchor || target;
}

/** Escape a string for use in a `RegExp` body. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite all occurrences of the broken wikilink in `source` to its
 *  display text (alias if the link has one, else the last segment of the
 *  target). `target` is the INNER wikilink text matching `UnresolvedIssue.raw`
 *  — e.g. `projects/foo/index` for a link written as `[[projects/foo/index]]`
 *  or `[[projects/foo/index|Foo]]`. */
export async function unlinkBrokenWikilink(
	source: string,
	target: string,
	vaultDir: string,
): Promise<LinkActionResult> {
	// Path safety — `source` comes from getHygieneReport() but we still
	// guard against absolute paths or traversal escaping the vault.
	if (!source || source.startsWith('/') || source.includes('..')) {
		return { ok: false, error: 'invalid-source' };
	}
	if (!target || target.includes('[[') || target.includes(']]')) {
		// We expect inner text, not the bracketed form. Reject either to
		// avoid the caller passing the wrong shape and producing a no-op.
		return { ok: false, error: 'invalid-target', detail: `target=${target}` };
	}

	const fullPath = join(vaultDir, source);
	try {
		await access(fullPath);
	} catch {
		return { ok: false, error: 'not-found', detail: `${source} missing` };
	}

	const original = await readFile(fullPath, 'utf-8');
	const wikiRegex = new RegExp(
		`\\[\\[${escapeRegex(target)}(?:\\|([^\\]]+))?\\]\\]`,
		'g',
	);
	let count = 0;
	const rewritten = original.replace(wikiRegex, (_match, alias) => {
		count++;
		if (alias) return alias.trim();
		return defaultDisplayFor(target);
	});

	if (count === 0) {
		return { ok: false, error: 'wikilink-not-found' };
	}

	await writeFile(fullPath, rewritten, 'utf-8');
	return {
		ok: true,
		detail: `replaced ${count} × \`[[${target}...]]\` in ${source}`,
	};
}
