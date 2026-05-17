#!/usr/bin/env node
/**
 * Tests for katib-build v1.0.0 (ADR-007 D2).
 *
 * Uses tests/fixtures/katib-stub/ as the katib_project_dir so we exercise
 * every code path of run.mjs without depending on ~/dev/katib state.
 * The stub's `scripts/build.py` is a PEP-723 Python script that mimics the
 * real katib build CLI shape and branches behaviour on the recipe filename.
 *
 * Run: node test_katib_build.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_MJS = resolve(__dirname, '..', 'run.mjs');
const STUB_DIR = resolve(__dirname, 'fixtures', 'katib-stub');

function invoke(payload) {
	return new Promise((resolveP) => {
		const proc = spawn('node', [RUN_MJS], { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.stderr.on('data', (d) => { stderr += d; });
		proc.on('close', (code) => resolveP({ code, stdout, stderr }));
		proc.stdin.end(JSON.stringify(payload));
	});
}

function parseOut(stdout) {
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`stdout was not JSON: ${stdout.slice(0, 300)}`);
	}
}

async function withTempDir(fn) {
	const dir = await mkdtemp(join(tmpdir(), 'katib-build-test-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ── Happy path ─────────────────────────────────────────────────────────────

async function test_happy_render() {
	await withTempDir(async (dir) => {
		const target = join(dir, 'out.pdf');
		const { code, stdout } = await invoke({
			recipe_path: 'happy.yaml',
			out_pdf: target,
			katib_project_dir: STUB_DIR,
		});
		if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout}`);
		const out = parseOut(stdout);
		if (out.pdf_path !== target) throw new Error(`pdf_path mismatch: ${out.pdf_path}`);
		if (typeof out.pdf_size_bytes !== 'number' || out.pdf_size_bytes <= 0) {
			throw new Error(`pdf_size_bytes should be positive, got ${out.pdf_size_bytes}`);
		}
		if (out.brand_resolved !== 'jasem') throw new Error(`brand_resolved wrong: ${out.brand_resolved}`);
		if (typeof out.build_duration_ms !== 'number') throw new Error('build_duration_ms missing');
		// Verify the stub actually wrote the file.
		const st = await stat(target);
		if (st.size !== out.pdf_size_bytes) throw new Error('stat size mismatch');
	});
}

async function test_custom_brand_and_lang() {
	await withTempDir(async (dir) => {
		const target = join(dir, 'out.pdf');
		const { code, stdout } = await invoke({
			recipe_path: 'happy.yaml',
			out_pdf: target,
			lang: 'ar',
			brand: 'unisons',
			katib_project_dir: STUB_DIR,
		});
		if (code !== 0) throw new Error(`expected exit 0, got ${code}; stdout: ${stdout}`);
		const out = parseOut(stdout);
		if (out.brand_resolved !== 'unisons') throw new Error(`brand_resolved wrong: ${out.brand_resolved}`);
		const content = await readFile(target, 'utf-8');
		if (!content.includes('lang=ar')) throw new Error(`lang not passed through: ${content}`);
		if (!content.includes('brand=unisons')) throw new Error(`brand not passed through: ${content}`);
	});
}

// ── Build failure (error_summary parsing) ─────────────────────────────────

async function test_build_fail_with_error_summary() {
	await withTempDir(async (dir) => {
		const target = join(dir, 'out.pdf');
		const { code, stdout } = await invoke({
			recipe_path: 'sad.yaml',
			out_pdf: target,
			katib_project_dir: STUB_DIR,
		});
		if (code !== 1) throw new Error(`expected exit 1 on build fail, got ${code}`);
		const out = parseOut(stdout);
		if (!out.error_summary) throw new Error(`error_summary missing; stdout: ${stdout}`);
		if (!/WeasyPrint/i.test(out.error_summary)) {
			throw new Error(`error_summary should mention WeasyPrint: ${out.error_summary}`);
		}
		if (typeof out.build_log_tail !== 'string' || !out.build_log_tail.length) {
			throw new Error('build_log_tail should be a non-empty string');
		}
		if (out.exit_code !== 1) throw new Error(`outputs.exit_code should be 1, got ${out.exit_code}`);
	});
}

async function test_missing_pdf_after_success() {
	await withTempDir(async (dir) => {
		const target = join(dir, 'out.pdf');
		const { code, stdout } = await invoke({
			recipe_path: 'missing-pdf.yaml',
			out_pdf: target,
			katib_project_dir: STUB_DIR,
		});
		if (code !== 1) throw new Error(`expected exit 1 when stub claims success but no PDF, got ${code}`);
		const out = parseOut(stdout);
		if (!out.error || !out.error.includes('missing')) {
			throw new Error(`error should mention missing PDF: ${out.error}`);
		}
	});
}

// ── Timeout ────────────────────────────────────────────────────────────────

async function test_timeout_kills_subprocess() {
	await withTempDir(async (dir) => {
		const target = join(dir, 'out.pdf');
		const startedAt = Date.now();
		const { code, stdout } = await invoke({
			recipe_path: 'slow.yaml',
			out_pdf: target,
			katib_project_dir: STUB_DIR,
			timeout_sec: 1,
		});
		const elapsed = Date.now() - startedAt;
		if (code !== 124) throw new Error(`expected exit 124 on timeout, got ${code}; stdout: ${stdout}`);
		if (elapsed > 9000) throw new Error(`timeout took ${elapsed}ms — SIGTERM didn't fire?`);
		const out = parseOut(stdout);
		if (out.timed_out !== true) throw new Error(`outputs.timed_out should be true`);
		if (!out.error_summary?.includes('timeout')) {
			throw new Error(`error_summary should mention timeout: ${out.error_summary}`);
		}
	});
}

// ── Bad inputs ─────────────────────────────────────────────────────────────

async function test_missing_recipe_path() {
	const { code } = await invoke({ out_pdf: '/tmp/x.pdf' });
	if (code !== 2) throw new Error(`expected exit 2 on missing recipe_path, got ${code}`);
}

async function test_missing_out_pdf() {
	const { code } = await invoke({ recipe_path: 'x.yaml' });
	if (code !== 2) throw new Error(`expected exit 2 on missing out_pdf, got ${code}`);
}

async function test_relative_out_pdf_refused() {
	const { code } = await invoke({ recipe_path: 'x.yaml', out_pdf: 'relative.pdf' });
	if (code !== 2) throw new Error(`expected exit 2 on relative out_pdf, got ${code}`);
}

async function test_invalid_lang() {
	const { code, stdout } = await invoke({
		recipe_path: 'happy.yaml',
		out_pdf: '/tmp/x.pdf',
		lang: 'klingon',
		katib_project_dir: STUB_DIR,
	});
	if (code !== 2) throw new Error(`expected exit 2 on invalid lang, got ${code}; stdout: ${stdout}`);
}

async function test_invalid_skip_audit_check_type() {
	const { code } = await invoke({
		recipe_path: 'happy.yaml',
		out_pdf: '/tmp/x.pdf',
		skip_audit_check: 'yes',
		katib_project_dir: STUB_DIR,
	});
	if (code !== 2) throw new Error(`expected exit 2 on non-boolean skip_audit_check, got ${code}`);
}

async function test_invalid_timeout() {
	const { code } = await invoke({
		recipe_path: 'happy.yaml',
		out_pdf: '/tmp/x.pdf',
		timeout_sec: -5,
		katib_project_dir: STUB_DIR,
	});
	if (code !== 2) throw new Error(`expected exit 2 on negative timeout, got ${code}`);
}

async function test_bad_json_stdin() {
	const proc = spawn('node', [RUN_MJS], { stdio: ['pipe', 'pipe', 'pipe'] });
	const { code } = await new Promise((resolveP) => {
		proc.on('close', (c) => resolveP({ code: c }));
		proc.stdin.end('not-json{{');
	});
	if (code !== 2) throw new Error(`expected exit 2 on bad JSON, got ${code}`);
}

// ── Runner ─────────────────────────────────────────────────────────────────

const tests = [
	test_happy_render,
	test_custom_brand_and_lang,
	test_build_fail_with_error_summary,
	test_missing_pdf_after_success,
	test_timeout_kills_subprocess,
	test_missing_recipe_path,
	test_missing_out_pdf,
	test_relative_out_pdf_refused,
	test_invalid_lang,
	test_invalid_skip_audit_check_type,
	test_invalid_timeout,
	test_bad_json_stdin,
];

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		await t();
		console.log(`✓ ${t.name}`);
		passed++;
	} catch (err) {
		console.error(`✗ ${t.name}: ${err.message}`);
		failed++;
	}
}
console.log(`\n${passed}/${tests.length} tests passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
