#!/usr/bin/env node
/**
 * katib-build component v1.0.0 — Tier-2 domain adapter per ADR-007 D2.
 *
 * Wraps `uv run scripts/build.py <recipe> --lang <lang> --brand <brand>
 * --out <out_pdf> [--skip-audit-check]` in ~/dev/katib. Owns:
 *   - Brand / lang / skip-audit semantics (typed inputs)
 *   - build.log failure parsing — surfaces last ERROR/WeasyPrint line as
 *     `error_summary` on non-zero exit
 *   - PDF stat-check on success — surfaces `pdf_size_bytes` for shadow-run
 *     parity comparisons
 *   - Wall-clock timeout via SIGTERM then SIGKILL after 5s grace
 *
 * I/O contract (see BLOCK.md):
 *   stdin:  { recipe_path, out_pdf, lang?, brand?, skip_audit_check?,
 *             katib_project_dir?, timeout_sec? }
 *   stdout: success { pdf_path, pdf_size_bytes, build_duration_ms, brand_resolved }
 *           failure { error, error_summary?, build_log_tail?, exit_code, build_duration_ms }
 *   exit:   0 ok | 1 build_fail | 2 bad_input | 124 timeout
 *
 * ESM, Node 18+. No external deps. Tests use a fixture katib-stub at
 * tests/fixtures/katib-stub/ so the publish gate runs in <5s without
 * touching the real ~/dev/katib.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

const EXIT = {
	OK: 0,
	BUILD_FAIL: 1,
	BAD_INPUT: 2,
	TIMEOUT: 124,
};

const KILL_GRACE_MS = 5_000;
const LOG_TAIL_LINES = 40;
const BUILD_LOG_RESPONSE_LINES = 20;
const ALLOWED_LANGS = new Set(['en', 'ar']);

function emit(obj) {
	process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, message, extra = {}) {
	emit({ error: message, ...extra });
	process.exit(code);
}

async function readStdin() {
	return new Promise((resolve, reject) => {
		let buf = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => { buf += chunk; });
		process.stdin.on('end', () => resolve(buf));
		process.stdin.on('error', reject);
	});
}

function validateInputs(payload) {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		fail(EXIT.BAD_INPUT, 'stdin JSON must be an object');
	}
	const {
		recipe_path,
		out_pdf,
		lang = 'en',
		brand = 'jasem',
		skip_audit_check = true,
		katib_project_dir,
		timeout_sec = 300,
	} = payload;

	if (typeof recipe_path !== 'string' || !recipe_path.trim()) {
		fail(EXIT.BAD_INPUT, 'recipe_path must be a non-empty string');
	}
	if (typeof out_pdf !== 'string' || !out_pdf.trim()) {
		fail(EXIT.BAD_INPUT, 'out_pdf must be a non-empty string');
	}
	if (!isAbsolute(out_pdf)) {
		fail(EXIT.BAD_INPUT, 'out_pdf must be an absolute path');
	}
	if (!ALLOWED_LANGS.has(lang)) {
		fail(EXIT.BAD_INPUT, `lang must be one of: ${[...ALLOWED_LANGS].join(', ')}`);
	}
	if (typeof brand !== 'string' || !brand.trim()) {
		fail(EXIT.BAD_INPUT, 'brand must be a non-empty string');
	}
	if (typeof skip_audit_check !== 'boolean') {
		fail(EXIT.BAD_INPUT, 'skip_audit_check must be a boolean');
	}
	if (katib_project_dir !== undefined && typeof katib_project_dir !== 'string') {
		fail(EXIT.BAD_INPUT, 'katib_project_dir must be a string');
	}
	if (typeof timeout_sec !== 'number' || !Number.isInteger(timeout_sec) || timeout_sec <= 0) {
		fail(EXIT.BAD_INPUT, 'timeout_sec must be a positive integer');
	}

	return {
		recipe_path,
		out_pdf,
		lang,
		brand,
		skip_audit_check,
		katib_project_dir: katib_project_dir || join(homedir(), 'dev', 'katib'),
		timeout_sec,
	};
}

function parseErrorSummary(buildLog) {
	const lines = buildLog.split('\n');
	const tail = lines.slice(-LOG_TAIL_LINES);
	const errPattern = /ERROR|WeasyPrint/i;
	for (let i = tail.length - 1; i >= 0; i--) {
		if (errPattern.test(tail[i])) return tail[i].trim();
	}
	return undefined;
}

function buildLogTailString(buildLog) {
	return buildLog.split('\n').slice(-BUILD_LOG_RESPONSE_LINES).join('\n');
}

async function main() {
	const raw = await readStdin();
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		fail(EXIT.BAD_INPUT, `stdin is not valid JSON: ${err.message}`);
	}

	const {
		recipe_path,
		out_pdf,
		lang,
		brand,
		skip_audit_check,
		katib_project_dir,
		timeout_sec,
	} = validateInputs(payload);

	const args = [
		'run', 'scripts/build.py',
		recipe_path,
		'--lang', lang,
		'--brand', brand,
		'--out', out_pdf,
	];
	if (skip_audit_check) args.push('--skip-audit-check');

	const startedAt = Date.now();
	const logChunks = [];
	let timedOut = false;
	let spawnFailed = false;
	let spawnErrorMsg = '';

	const proc = spawn('uv', args, {
		cwd: katib_project_dir,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		try { proc.kill('SIGTERM'); } catch { /* ignore */ }
		setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* ignore */ }
		}, KILL_GRACE_MS);
	}, timeout_sec * 1000);

	proc.stdout.on('data', (d) => logChunks.push(d));
	proc.stderr.on('data', (d) => logChunks.push(d));
	proc.on('error', (err) => {
		spawnFailed = true;
		spawnErrorMsg = err.message;
	});

	const rawExitCode = await new Promise((resolveP) => {
		proc.on('close', (code) => {
			clearTimeout(timeoutHandle);
			resolveP(code ?? -1);
		});
	});

	const buildDurationMs = Date.now() - startedAt;
	const buildLog = Buffer.concat(logChunks).toString('utf-8');

	if (spawnFailed) {
		emit({
			error: `katib spawn failed: ${spawnErrorMsg}`,
			error_summary: spawnErrorMsg,
			build_duration_ms: buildDurationMs,
			katib_project_dir,
		});
		process.exit(EXIT.BUILD_FAIL);
	}

	if (timedOut) {
		emit({
			error: `katib build exceeded timeout_sec=${timeout_sec}`,
			error_summary: 'timeout — SIGTERM sent, then SIGKILL after 5s grace',
			build_duration_ms: buildDurationMs,
			build_log_tail: buildLogTailString(buildLog),
			timed_out: true,
		});
		process.exit(EXIT.TIMEOUT);
	}

	if (rawExitCode !== 0) {
		const errorSummary = parseErrorSummary(buildLog);
		emit({
			error: `katib build failed (exit ${rawExitCode})`,
			...(errorSummary ? { error_summary: errorSummary } : {}),
			build_log_tail: buildLogTailString(buildLog),
			exit_code: rawExitCode,
			build_duration_ms: buildDurationMs,
		});
		process.exit(EXIT.BUILD_FAIL);
	}

	// Success — stat the PDF.
	let pdfSize;
	try {
		const st = await stat(out_pdf);
		pdfSize = st.size;
	} catch (err) {
		emit({
			error: `katib reported success but PDF missing at ${out_pdf}: ${err.message}`,
			error_summary: 'PDF stat failed post-build',
			build_log_tail: buildLogTailString(buildLog),
			build_duration_ms: buildDurationMs,
		});
		process.exit(EXIT.BUILD_FAIL);
	}

	emit({
		pdf_path: out_pdf,
		pdf_size_bytes: pdfSize,
		build_duration_ms: buildDurationMs,
		brand_resolved: brand,
	});
	process.exit(EXIT.OK);
}

main().catch((err) => {
	fail(EXIT.BAD_INPUT, `unexpected error: ${err.message || err}`);
});
