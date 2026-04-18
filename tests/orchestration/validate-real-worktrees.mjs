#!/usr/bin/env node
/**
 * Integration test: run the validator against real worker worktrees from the
 * existing orch-1776499692673-f571538b run. Answers: does validation correctly
 * isolate which worker(s) produced broken code?
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const { validateWorker } = await import('../../src/lib/orchestration/worker-validator.ts');

const base = '/Users/jneaimi/dev/buisness-qr-code/.worktrees';
const entries = await readdir(base);
const worktrees = entries
	.filter((e) => e.startsWith('orch-1776499692673-f571538b-'))
	.sort();

console.log(`\nValidating ${worktrees.length} worker worktrees...\n`);

const results = [];
for (const wt of worktrees) {
	const taskId = wt.replace('orch-1776499692673-f571538b-', '');
	const worktreePath = join(base, wt);
	const fakeWorker = {
		taskId,
		workerId: 'test',
		status: 'done',
		worktreePath,
		branch: `orchestration/orch-1776499692673-f571538b/${taskId}`,
		iterationCount: 0,
	};

	process.stdout.write(`  ${taskId.padEnd(16)} ... `);
	try {
		const v = await validateWorker('test-run', fakeWorker, () => {});
		const badge = v.passed ? '✅ PASS' : '❌ FAIL';
		const dur = `${Math.round(v.durationMs / 1000)}s`;
		console.log(`${badge}  (${dur})`);
		if (!v.passed) {
			const failing = v.steps.filter((s) => s.status === 'failed');
			for (const s of failing) {
				const first = (s.output || '').split('\n').find((l) => /error|failed|\.(ts|svelte|py|rs|go)/i.test(l))?.trim();
				console.log(`      ✗ ${s.name}: ${first?.slice(0, 120) ?? '(no detail)'}`);
			}
		}
		results.push({ taskId, passed: v.passed });
	} catch (err) {
		console.log(`💥 ERROR  ${err.message}`);
		results.push({ taskId, passed: false, error: err.message });
	}
}

console.log('\nSummary:');
const pass = results.filter((r) => r.passed).length;
const fail = results.filter((r) => !r.passed).length;
console.log(`  ${pass} passed, ${fail} failed`);
console.log('\nExpected: at least public-card fails (introduced Buffer/BodyInit bug)');
