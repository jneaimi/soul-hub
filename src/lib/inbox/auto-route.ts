/** Layer 3 Stage 4 — auto vault-routing worker.
 *
 *  See ADR 2026-05-11-inbox-agent-workflows-layer-3 §D5.
 *
 *  Periodic loop (default 60s) that picks queued messages whose category
 *  + cached `extracted_data` match an operator-enabled per-category rule
 *  and saves them to the vault. ALL rules default OFF — the operator
 *  opts in per-category. The only Layer 3 surface that auto-acts.
 *
 *  Composition with the existing inbox machinery:
 *    - L2 filter classifies + caches → queued
 *    - L3 S2 extracts transactional data → extracted_data
 *    - L3 S3a (heartbeat) maybe-pushes anomalies → agent_actions
 *    - L3 S4 (this worker) maybe-routes to vault → agent_actions + vault note + processed
 *
 *  Deduplication: an `inbox-route-to-vault` agent_actions row whose
 *  `result.ok=1` is the load-bearing exclusion. Without it the worker
 *  would re-route on every tick. Idempotency inside routeMessageToVault
 *  (checks processStatus=='processed' before saving) is a second-line
 *  defense in case the candidate query and the action log fall out of
 *  sync.
 *
 *  Kill switches honored at every tick:
 *    INBOX_AGENT_DISABLED=1 — all Layer 3 tools off
 *    INBOX_AUTO_ROUTE_DISABLED=1 — auto-route specifically off
 *    cfg.inbox.autoRoute.enabled=false — operator master toggle
 */

import { getInboxDb, rowToMessage } from './db.js';
import { routeMessageToVault } from './route-to-vault.js';
import type { InboxMessage } from './types.js';
import type { TransactionalExtract } from './extractor.js';
import type { InboxAutoRouteConfig } from '../config.schema.js';

export interface ListAutoRouteCandidatesOptions {
	lookbackHours: number;
	limit: number;
}

/** Fetch rows eligible for auto-route this tick.
 *
 *  Requirements:
 *    - process_status='queued' (skip processed/skipped/new)
 *    - category in (transactional, notification) — the two surfaces with
 *      rules in v1; personal stays manual-save-only
 *    - extracted_data present for transactional (we need the kind/amount
 *      to apply rules); NULL ok for notification (rules don't read it)
 *    - within lookback window
 *    - NO prior `inbox-route-to-vault` success in agent_actions
 *
 *  Permissive query — the gate function decides routing based on current
 *  rule config, so a row that didn't match yesterday's threshold can
 *  match today's lower one. */
export function listAutoRouteCandidates(opts: ListAutoRouteCandidatesOptions): InboxMessage[] {
	const db = getInboxDb();
	const sinceMs = Date.now() - opts.lookbackHours * 3600 * 1000;
	const rows = db
		.prepare(
			`SELECT m.* FROM messages m
			 WHERE m.process_status = 'queued'
			   AND m.category IN ('transactional', 'notification')
			   AND m.date_received > ?
			   AND NOT EXISTS (
				 SELECT 1 FROM agent_actions a
				 WHERE a.message_id = m.id
				   AND a.tool = 'inbox-route-to-vault'
				   AND json_extract(a.result, '$.ok') = 1
			   )
			 ORDER BY m.date_received ASC
			 LIMIT ?`,
		)
		.all(sinceMs, opts.limit) as Record<string, unknown>[];
	return rows.map(rowToMessage);
}

export type AutoRouteReason =
	| 'receipt.over-threshold'
	| 'payment.over-threshold'
	| 'alert.anomaly'
	| 'shipping.always'
	| 'service-alert.anomaly'
	| 'no-match';

export interface AutoRouteDecision {
	route: boolean;
	reason: AutoRouteReason;
}

/** Apply the per-category rules. Returns {route, reason} so the worker
 *  records the reason in agent_actions for tuning later. */
export function evaluateAutoRouteRule(
	message: InboxMessage,
	extract: TransactionalExtract | null,
	cfg: InboxAutoRouteConfig,
): AutoRouteDecision {
	if (message.category === 'transactional') {
		if (!extract) return { route: false, reason: 'no-match' };

		if (extract.kind === 'receipt' && cfg.receipts.enabled) {
			if (matchesAmount(extract, cfg.receipts.minAmount, cfg.receipts.currency)) {
				return { route: true, reason: 'receipt.over-threshold' };
			}
		}
		if (extract.kind === 'payment' && cfg.payments.enabled) {
			if (matchesAmount(extract, cfg.payments.minAmount, cfg.payments.currency)) {
				return { route: true, reason: 'payment.over-threshold' };
			}
		}
		if (extract.kind === 'alert' && cfg.alerts.enabled) {
			if (!cfg.alerts.anomalyOnly || extract.anomalyHint === true) {
				return { route: true, reason: 'alert.anomaly' };
			}
		}
		// OTPs, refunds, subscription-renewals, unknown — no v1 rule. Defer.
		return { route: false, reason: 'no-match' };
	}

	if (message.category === 'notification') {
		// Shipping is the always-on slot; we use a subject heuristic to
		// distinguish it from generic service-alerts. The extractor doesn't
		// run on notifications today, so we lean on the from-address /
		// subject for the split.
		const looksLikeShipping = SHIPPING_PATTERN.test(message.subject)
			|| SHIPPING_PATTERN.test(message.fromAddress);
		if (looksLikeShipping && cfg.shipping.enabled) {
			return { route: true, reason: 'shipping.always' };
		}
		if (!looksLikeShipping && cfg.serviceAlerts.enabled) {
			// service-alerts can require anomaly-only when the extractor
			// has populated data for the row (rare for notification today
			// but the gate stays consistent if S2 expands to notifications).
			if (!cfg.serviceAlerts.anomalyOnly || extract?.anomalyHint === true) {
				return { route: true, reason: 'service-alert.anomaly' };
			}
		}
		return { route: false, reason: 'no-match' };
	}

	return { route: false, reason: 'no-match' };
}

/** Shipping subject/sender heuristic. The keywords are conservative —
 *  better to under-route shipping than mislabel a service-alert. */
const SHIPPING_PATTERN = /\b(shipped|shipment|tracking|delivery|out for delivery|in transit|arriving|noon|amazon|aramex|dhl|fedex|fetchr)\b/i;

function matchesAmount(extract: TransactionalExtract, minAmount: number, currency: string): boolean {
	if (typeof extract.amount !== 'number' || !Number.isFinite(extract.amount)) return false;
	if (extract.amount < minAmount) return false;
	const expectedCur = currency.trim().toUpperCase();
	const actualCur = (extract.currency || '').trim().toUpperCase();
	// Empty currency on the row means we don't know — defer rather than route
	// against the wrong currency. Empty-config currency means "any" (rare).
	if (!actualCur) return false;
	if (expectedCur && expectedCur !== actualCur) return false;
	return true;
}

export interface AutoRouteTickResult {
	considered: number;
	routed: number;
	skipped: number;
	errors: number;
	stopReason?: 'kill-switch' | 'master-disabled' | 'empty';
}

let tickInProgress = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Run one auto-route tick. Returns counts for telemetry. */
export async function runAutoRouteTick(cfg: InboxAutoRouteConfig): Promise<AutoRouteTickResult> {
	if (killSwitchActive()) {
		return { considered: 0, routed: 0, skipped: 0, errors: 0, stopReason: 'kill-switch' };
	}
	if (!cfg.enabled) {
		return { considered: 0, routed: 0, skipped: 0, errors: 0, stopReason: 'master-disabled' };
	}

	const candidates = listAutoRouteCandidates({
		lookbackHours: cfg.lookbackHours,
		limit: cfg.perTickCap * 4, // overfetch — many won't match rules
	});
	if (candidates.length === 0) {
		return { considered: 0, routed: 0, skipped: 0, errors: 0, stopReason: 'empty' };
	}

	let routed = 0;
	let skipped = 0;
	let errors = 0;

	for (const msg of candidates) {
		if (routed >= cfg.perTickCap) break;
		const extract = parseExtractedData(msg);
		const decision = evaluateAutoRouteRule(msg, extract, cfg);
		if (!decision.route) {
			skipped += 1;
			continue;
		}
		try {
			const result = await routeMessageToVault(msg.id, {
				actor: 'worker',
				reason: decision.reason,
			});
			if (result.ok) routed += 1;
			else errors += 1;
		} catch (err) {
			console.warn(
				`[inbox-auto-route] route-to-vault threw for msg ${msg.id}: ${(err as Error).message}`,
			);
			errors += 1;
		}
	}

	return { considered: candidates.length, routed, skipped, errors };
}

function parseExtractedData(message: InboxMessage): TransactionalExtract | null {
	if (!message.extractedData) return null;
	try {
		return JSON.parse(message.extractedData) as TransactionalExtract;
	} catch {
		return null;
	}
}

function killSwitchActive(): boolean {
	if (process.env.INBOX_AGENT_DISABLED === '1') return true;
	if (process.env.INBOX_AUTO_ROUTE_DISABLED === '1') return true;
	return false;
}

/** Boot hook. Spins up the periodic tick. Idempotent — calling twice is
 *  a no-op (start is guarded by `intervalHandle`). The caller (hooks.server.ts)
 *  passes a thunk that loads the latest config on each tick so config edits
 *  via settings.json take effect without a worker restart. */
export function startAutoRouteWorker(getConfig: () => InboxAutoRouteConfig): void {
	if (intervalHandle) return;
	const initial = safeGetConfig(getConfig);
	if (!initial) {
		console.warn('[inbox-auto-route] startup skipped — config not loadable');
		return;
	}
	if (killSwitchActive()) {
		console.log(
			'[inbox-auto-route] startup skipped — kill switch (INBOX_AGENT_DISABLED or INBOX_AUTO_ROUTE_DISABLED) is set',
		);
		return;
	}

	const tickInterval = initial.intervalMs;
	const tick = async () => {
		if (tickInProgress) return;
		tickInProgress = true;
		try {
			const cfg = safeGetConfig(getConfig);
			if (!cfg) return;
			const result = await runAutoRouteTick(cfg);
			if (result.routed > 0 || result.errors > 0) {
				console.log(
					`[inbox-auto-route] tick: considered=${result.considered} routed=${result.routed} skipped=${result.skipped} errors=${result.errors}`,
				);
			}
		} catch (err) {
			console.error(`[inbox-auto-route] tick threw: ${(err as Error).message}`);
		} finally {
			tickInProgress = false;
		}
	};

	intervalHandle = setInterval(() => void tick(), tickInterval);
	console.log(`[inbox-auto-route] worker started (poll ${Math.round(tickInterval / 1000)}s)`);
}

/** Shutdown hook for graceful PM2 reload. */
export function stopAutoRouteWorker(): void {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
		console.log('[inbox-auto-route] worker stopped');
	}
}

function safeGetConfig(getConfig: () => InboxAutoRouteConfig): InboxAutoRouteConfig | null {
	try {
		return getConfig();
	} catch (err) {
		console.warn(`[inbox-auto-route] failed to load config: ${(err as Error).message}`);
		return null;
	}
}
