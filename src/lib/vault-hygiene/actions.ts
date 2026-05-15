/** ADR-042 — Hygiene remediation actions (Step 1).
 *
 *  Pure functions that act on hygiene anomalies. Called from the
 *  Telegram callback handler (`callback.ts`) when the operator taps an
 *  inline button on a keeper escalation. No LLM in the path — the
 *  operator's intent is unambiguous, so we execute deterministically.
 *
 *  All three actions are reversible:
 *   - archiveProject  → `git revert` restores the folder + wikilinks
 *   - setPauseUntil   → re-edit the frontmatter to drop the field
 *   - suppressAnomaly → wipe the JSON file (or wait 30 days)
 */

import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const SUPPRESSIONS_PATH = join(homedir(), '.soul-hub', 'data', 'hygiene-suppressions.json');
const SUPPRESS_DAYS_DEFAULT = 30;
const PROJECT_SLUG_RX = /^[a-z][a-z0-9-]*$/;

export interface ActionResult {
	ok: boolean;
	error?: string;
	detail?: string;
}

interface Suppression {
	slug: string;
	bucket: string;
	until: string; // YYYY-MM-DD
}

/** Run a git command in the vault dir. Resolves with stdout on success,
 *  rejects with stderr-containing Error on non-zero exit. Mirrors the
 *  private helper in VaultCommitter — kept local rather than exported
 *  because the surface here is narrow. */
function runGit(vaultDir: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', ['-C', vaultDir, ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c.toString()));
		child.stderr.on('data', (c) => (stderr += c.toString()));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
		});
	});
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/** Move `projects/<slug>` → `archive/<slug>`. Validates the slug,
 *  asserts the source has `status: archived` (defensive — caller
 *  should have verified), guards against archive-side collisions,
 *  and commits the move with a hygiene-attributed message. The
 *  vault watcher auto-rewrites stale wikilinks pointing at the old
 *  path. */
export async function archiveProject(slug: string, vaultDir: string): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug', detail: `slug must match ${PROJECT_SLUG_RX}` };
	}

	const src = join(vaultDir, 'projects', slug);
	const dst = join(vaultDir, 'archive', slug);
	const srcIndex = join(src, 'index.md');

	if (!(await pathExists(srcIndex))) {
		return { ok: false, error: 'not-found', detail: `projects/${slug}/index.md missing` };
	}
	if (await pathExists(dst)) {
		return { ok: false, error: 'collision', detail: `archive/${slug} already exists` };
	}

	const indexText = await readFile(srcIndex, 'utf-8');
	const statusMatch = indexText.match(/^status:\s*['"]?(\w+)['"]?\s*$/m);
	const status = statusMatch?.[1]?.toLowerCase() ?? '';
	if (status !== 'archived') {
		return {
			ok: false,
			error: 'wrong-status',
			detail: `project status is "${status}" — set to "archived" before moving`,
		};
	}

	try {
		await runGit(vaultDir, ['mv', `projects/${slug}`, `archive/${slug}`]);
		await runGit(vaultDir, [
			'commit',
			'-m',
			`vault(hygiene): archive ${slug} (ADR-042 inline action)`,
		]);
	} catch (err) {
		return {
			ok: false,
			error: 'git-failed',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	return { ok: true, detail: `moved projects/${slug} → archive/${slug}` };
}

/** Inject `pause_until: YYYY-MM-DD` into the project's index.md
 *  frontmatter. Replaces any existing pause_until. Caller passes an
 *  ISO date string. The vault watcher's commit picks the write up
 *  naturally — no explicit commit here. */
export async function setPauseUntil(
	slug: string,
	dateIso: string,
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
		return { ok: false, error: 'invalid-date', detail: 'expected YYYY-MM-DD' };
	}

	const idxPath = join(vaultDir, 'projects', slug, 'index.md');
	if (!(await pathExists(idxPath))) {
		return { ok: false, error: 'not-found', detail: `projects/${slug}/index.md missing` };
	}

	const original = await readFile(idxPath, 'utf-8');
	if (!original.startsWith('---')) {
		return { ok: false, error: 'no-frontmatter' };
	}
	const fmEnd = original.indexOf('\n---', 3);
	if (fmEnd === -1) {
		return { ok: false, error: 'malformed-frontmatter' };
	}

	const fmBlock = original.slice(0, fmEnd);
	const rest = original.slice(fmEnd);

	let newFm: string;
	if (/^pause_until:/m.test(fmBlock)) {
		newFm = fmBlock.replace(/^pause_until:.*$/m, `pause_until: '${dateIso}'`);
	} else {
		// Append at end of frontmatter block (before closing ---)
		newFm = fmBlock.replace(/\n$/, '') + `\npause_until: '${dateIso}'`;
	}

	await writeFile(idxPath, newFm + rest, 'utf-8');
	return { ok: true, detail: `pause_until set to ${dateIso}` };
}

/** Suppress an anomaly bucket for this slug for `days` days. Writes to
 *  ~/.soul-hub/data/hygiene-suppressions.json — cross-language readable
 *  so the Python project_hygiene.py script can skip suppressed entries
 *  on its next run. Existing suppression for the same (slug,bucket)
 *  is replaced. */
export async function suppressAnomaly(
	slug: string,
	bucket: string,
	days = SUPPRESS_DAYS_DEFAULT,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	if (!/^[a-z_]+$/.test(bucket)) {
		return { ok: false, error: 'invalid-bucket' };
	}

	const untilMs = Date.now() + days * 86400 * 1000;
	const until = new Date(untilMs).toISOString().slice(0, 10); // YYYY-MM-DD

	let suppressions: Suppression[] = [];
	if (await pathExists(SUPPRESSIONS_PATH)) {
		try {
			const text = await readFile(SUPPRESSIONS_PATH, 'utf-8');
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) suppressions = parsed;
		} catch {
			// Corrupt file — overwrite with fresh state. The cost of losing
			// prior suppressions is bounded (they'll re-fire on next run).
			suppressions = [];
		}
	}

	suppressions = suppressions.filter((s) => !(s.slug === slug && s.bucket === bucket));
	suppressions.push({ slug, bucket, until });

	await mkdir(dirname(SUPPRESSIONS_PATH), { recursive: true });
	await writeFile(SUPPRESSIONS_PATH, JSON.stringify(suppressions, null, 2) + '\n', 'utf-8');

	return { ok: true, detail: `suppressed ${slug}:${bucket} until ${until}` };
}
