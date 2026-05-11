/** One-time backfill — extracts every transactional row where
 *  `extracted_data IS NULL`. Lets the Stage 2 burn-in start with a real
 *  sample without waiting for natural mail flow.
 *
 *  Run: `npx tsx scripts/backfill-inbox-extract.ts [--dry-run] [--limit N]`
 *
 *  - Serial 1-RPS-ish pace — Gemini Flash is generous but no need to
 *    burst. ~1s per row × 258 = ~4-5 minutes.
 *  - Audit log uses actor='operator-direct' + args={mode:'backfill'} so
 *    these rows are distinguishable from natural eager-mode runs
 *    (actor='worker', args.mode='eager') and from on-demand tool calls
 *    (actor='orchestrator').
 *  - Failures cache as {kind:'unknown', note} — the same retry-proof
 *    contract the orchestrator tool uses.
 *  - On Ctrl-C, the in-flight row's update lands but no further rows
 *    process (the loop check fires before each request). */

import {
	getInboxDb,
	rowToMessage,
	extractTransactional,
	inputFromMessage,
	setExtractedData,
	recordAgentAction,
	type TransactionalExtract,
} from '../src/lib/inbox/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Number.POSITIVE_INFINITY;

const db = getInboxDb();
const rows = db
	.prepare(
		`SELECT * FROM messages WHERE category='transactional' AND extracted_data IS NULL ORDER BY date_received DESC LIMIT ?`,
	)
	.all(Number.isFinite(limit) ? limit : 1000) as Record<string, unknown>[];

console.log(`Backfill target: ${rows.length} unextracted transactional rows.${dryRun ? ' (dry-run)' : ''}\n`);

if (rows.length === 0) {
	console.log('Nothing to do.');
	process.exit(0);
}

if (dryRun) {
	rows.slice(0, 10).forEach((r) => {
		const m = rowToMessage(r);
		console.log(`  ${m.id} — ${m.subject.slice(0, 70)}`);
	});
	if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more`);
	process.exit(0);
}

const stats = {
	processed: 0,
	ok: 0,
	failed: 0,
	byKind: {} as Record<string, number>,
	totalMs: 0,
};

const t0 = Date.now();
for (let i = 0; i < rows.length; i++) {
	const msg = rowToMessage(rows[i]);
	const rowStart = Date.now();
	try {
		const result = await extractTransactional(inputFromMessage(msg));
		setExtractedData(msg.id, result.extract);
		recordAgentAction({
			tool: 'inbox-extract-data',
			messageId: msg.id,
			actor: 'operator-direct',
			args: { mode: 'backfill' },
			result: { ok: result.ok, kind: result.extract.kind, reason: result.reason },
		});
		stats.processed++;
		if (result.ok) stats.ok++;
		else stats.failed++;
		stats.byKind[result.extract.kind] = (stats.byKind[result.extract.kind] || 0) + 1;
		stats.totalMs += Date.now() - rowStart;
	} catch (err) {
		stats.processed++;
		stats.failed++;
		console.warn(`  ${msg.id} EXCEPTION: ${(err as Error).message}`);
	}

	if ((i + 1) % 10 === 0 || i === rows.length - 1) {
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
		const avgMs = (stats.totalMs / Math.max(stats.processed, 1)).toFixed(0);
		console.log(
			`  [${i + 1}/${rows.length}] elapsed=${elapsed}s avg=${avgMs}ms ok=${stats.ok} fail=${stats.failed}`,
		);
	}
}

const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${totalSec}s.`);
console.log(`  processed: ${stats.processed}`);
console.log(`  ok:        ${stats.ok}`);
console.log(`  failed:    ${stats.failed}`);
console.log(`  byKind:`, stats.byKind);

// Cost estimate (Gemini 2.5 Flash, rough):
//   input  ~ 400 tok @ $0.075/1M  = $0.00003/row
//   output ~ 150 tok @ $0.30/1M   = $0.000045/row
//   total ≈ $0.00008/row
const estCost = (stats.processed * 0.00008).toFixed(4);
console.log(`  est. cost: ~$${estCost}`);
