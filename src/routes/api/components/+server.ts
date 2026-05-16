/**
 * /api/components — Naseej component catalog (listing + publish gate).
 *
 * GET   ?category=&runtime=&q=    — list all valid components with filters.
 * POST  { name: string }          — validate a component against the publish gate.
 *
 * The POST publish gate enforces three checks:
 *   1. manifest_schema — BLOCK.md frontmatter parses against the Zod schema
 *   2. entry_exists    — run.py / run.mjs is present at the expected path
 *   3. tests           — every tests/test_*.{py,mjs} subprocess exits with code 0
 *                        within the per-file timeout (default 60s)
 *
 * Response is structured (`checks: [{ name, status, ... }]`) so callers can
 * surface the exact failure to the operator without parsing prose.
 *
 * Status codes:
 *   200 — all checks passed (safe to `git add` and ship)
 *   422 — component exists but a check failed
 *   404 — `catalog/components/<name>/` doesn't exist
 *   400 — bad request body
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import {
	DEFAULT_CATALOG_DIR,
	fileExists,
	loadAllComponentManifests,
	loadComponentManifestSafe,
} from '$lib/naseej/manifest.js';

/** Per-test-file timeout. Tests today run in <2s (stop-slop) to <10s (vault-write). */
const TEST_TIMEOUT_MS = 60_000;

/** Valid component name pattern (mirrors the Zod schema). Enforced before any
 *  disk access to block path traversal. */
const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface TestFileResult {
	file: string;
	exit_code: number;
	duration_ms: number;
	timed_out: boolean;
	stderr_excerpt?: string;
}

type CheckResult =
	| { name: 'manifest_schema'; status: 'passed' | 'failed'; errors?: unknown[] }
	| { name: 'entry_exists'; status: 'passed' | 'failed'; detail?: string }
	| {
			name: 'tests';
			status: 'passed' | 'failed' | 'skipped';
			detail?: string;
			test_files?: TestFileResult[];
	  };

interface PublishResult {
	component: string;
	version?: string;
	status: 'passed' | 'failed';
	duration_ms: number;
	checks: CheckResult[];
}

/** Spawn one test file. Returns the exit code + duration + (stderr excerpt on failure). */
function runTestFile(
	file: string,
	cwd: string,
	timeoutMs: number,
): Promise<TestFileResult> {
	const isPython = file.endsWith('.py');
	const command = isPython ? 'uv' : 'node';
	const args = isPython ? ['run', file] : [file];
	return new Promise((resolveP) => {
		const startedAt = Date.now();
		const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
		let stderr = '';
		proc.stderr.on('data', (d) => {
			stderr += d;
			// Cap accumulation at ~16KB to bound memory if a test screams
			if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
		});
		const timeoutHandle = setTimeout(() => {
			proc.kill('SIGTERM');
			setTimeout(() => proc.kill('SIGKILL'), 2000);
		}, timeoutMs);
		proc.on('close', (code, signal) => {
			clearTimeout(timeoutHandle);
			const timed_out = signal === 'SIGTERM' || signal === 'SIGKILL';
			const result: TestFileResult = {
				file: file.split('/').slice(-3).join('/'),
				exit_code: code ?? -1,
				duration_ms: Date.now() - startedAt,
				timed_out,
			};
			if ((code ?? -1) !== 0 || timed_out) {
				result.stderr_excerpt = stderr.trim().slice(-1024) || undefined;
			}
			resolveP(result);
		});
	});
}

/** Discover tests/test_*.{py,mjs} under a component dir. */
async function discoverTests(componentDir: string): Promise<string[]> {
	const testsDir = join(componentDir, 'tests');
	let entries: string[];
	try {
		entries = await readdir(testsDir);
	} catch {
		return [];
	}
	return entries
		.filter((e) => /^test_.+\.(py|mjs)$/.test(e))
		.map((e) => join(testsDir, e))
		.sort();
}

/** GET /api/components — list Naseej components from catalog/components/.
 *  Filters: ?category=, ?runtime=, ?q= (substring on name + description) */
export const GET: RequestHandler = async ({ url }) => {
	const records = await loadAllComponentManifests();
	const category = url.searchParams.get('category')?.toLowerCase() || null;
	const runtime = url.searchParams.get('runtime')?.toLowerCase() || null;
	const q = url.searchParams.get('q')?.toLowerCase() || null;

	const results = records
		.filter((r) => {
			if (category && (r.manifest.category || '').toLowerCase() !== category) return false;
			if (runtime && r.manifest.runtime.toLowerCase() !== runtime) return false;
			if (q) {
				const hay = `${r.manifest.name} ${r.manifest.description || ''}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		})
		.map((r) => ({
			name: r.manifest.name,
			version: r.manifest.version,
			id: r.id,
			type: r.manifest.type,
			category: r.manifest.category,
			runtime: r.manifest.runtime,
			description: r.manifest.description,
			author: r.manifest.author,
			project: r.manifest.project,
			inputs: r.manifest.inputs,
			outputs: r.manifest.outputs,
			invocation: r.manifest.invocation,
			manifest_path: r.manifest_path,
		}));

	const facets = {
		categories: Array.from(
			new Set(records.map((r) => r.manifest.category).filter((v): v is string => !!v)),
		).sort(),
		runtimes: Array.from(new Set(records.map((r) => r.manifest.runtime))).sort(),
	};

	return json({ results, total: results.length, facets });
};

/** POST /api/components — validate a component against the publish gate.
 *  Body: { name: string }   (component dir under catalog/components/) */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { name } = (body as Record<string, unknown>) ?? {};
	if (typeof name !== 'string' || !name) {
		return json({ error: 'name (string) is required' }, { status: 400 });
	}
	if (!NAME_RE.test(name)) {
		return json(
			{ error: `name must match ${NAME_RE.source} (kebab-case, starts with a letter)` },
			{ status: 400 },
		);
	}

	const componentDir = resolvePath(DEFAULT_CATALOG_DIR, name);
	// Path-traversal defence (NAME_RE already blocks `/` and `..`, this is belt-and-braces)
	if (!componentDir.startsWith(DEFAULT_CATALOG_DIR + '/')) {
		return json({ error: 'name resolves outside catalog/components/' }, { status: 400 });
	}
	if (!(await fileExists(componentDir))) {
		return json(
			{ error: `component not found: catalog/components/${name}` },
			{ status: 404 },
		);
	}

	const startedAt = Date.now();
	const checks: CheckResult[] = [];

	// Check 1: manifest_schema
	const safe = await loadComponentManifestSafe(componentDir);
	if (!safe.ok) {
		const errors =
			safe.reason === 'schema_invalid'
				? safe.errors
				: [{ path: [], message: `${safe.reason}: ${safe.detail}` }];
		checks.push({ name: 'manifest_schema', status: 'failed', errors });
		const result: PublishResult = {
			component: name,
			status: 'failed',
			duration_ms: Date.now() - startedAt,
			checks,
		};
		return json(result, { status: 422 });
	}
	checks.push({ name: 'manifest_schema', status: 'passed' });

	const record = safe.record;

	// Check 2: entry_exists
	if (!(await fileExists(record.entry))) {
		checks.push({
			name: 'entry_exists',
			status: 'failed',
			detail: `expected ${record.entry.replace(process.cwd() + '/', '')} not found`,
		});
		const result: PublishResult = {
			component: record.manifest.name,
			version: record.manifest.version,
			status: 'failed',
			duration_ms: Date.now() - startedAt,
			checks,
		};
		return json(result, { status: 422 });
	}
	checks.push({ name: 'entry_exists', status: 'passed' });

	// Check 3: tests
	const testFiles = await discoverTests(componentDir);
	if (testFiles.length === 0) {
		checks.push({
			name: 'tests',
			status: 'skipped',
			detail: 'no tests/test_*.{py,mjs} files found',
		});
	} else {
		const testResults = await Promise.all(
			testFiles.map((f) => runTestFile(f, record.dir, TEST_TIMEOUT_MS)),
		);
		const allPassed = testResults.every((t) => t.exit_code === 0 && !t.timed_out);
		checks.push({
			name: 'tests',
			status: allPassed ? 'passed' : 'failed',
			test_files: testResults,
		});
	}

	const failed = checks.some((c) => c.status === 'failed');
	const result: PublishResult = {
		component: record.manifest.name,
		version: record.manifest.version,
		status: failed ? 'failed' : 'passed',
		duration_ms: Date.now() - startedAt,
		checks,
	};
	return json(result, { status: failed ? 422 : 200 });
};
