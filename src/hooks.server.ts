import type { Handle } from '@sveltejs/kit';
import { config } from '$lib/config.js';
import {
	initSchedulerCore,
	shutdownScheduler,
	registerTaskHandler,
} from '$lib/scheduler/index.js';
import { shellScriptFactory } from '$lib/scheduler/handlers/shell-script.js';
import { dailyFocusFactory } from '$lib/scheduler/handlers/daily-focus.js';
import { vaultScoutFactory } from '$lib/scheduler/handlers/vault-scout.js';
import { inboxDigestFactory } from '$lib/scheduler/handlers/inbox-digest.js';
import { inboxDigestTelegramFactory } from '$lib/scheduler/handlers/inbox-digest-telegram.js';
import { inboxAnomalyTelegramFactory } from '$lib/scheduler/handlers/inbox-anomaly-telegram.js';
import { intentMiningFactory } from '$lib/scheduler/handlers/intent-mining.js';
import { telegramLivenessFactory } from '$lib/scheduler/handlers/telegram-liveness.js';
import { hygieneButtonEscalatorFactory } from '$lib/scheduler/handlers/hygiene-button-escalator.js';
import { initVault, getVaultEngine } from '$lib/vault/index.js';
import { initSystemHealth, getSystemHealth } from '$lib/system/index.js';
import { listSessions, killSession } from '$lib/pty/manager.js';
import { extractProxyPort, proxyRequest } from '$lib/proxy.js';
import {
	getInboxDb, closeInboxDb, startSync, stopSync,
	startFilterWorker, stopFilterWorker,
	startAutoRouteWorker, stopAutoRouteWorker,
} from '$lib/inbox/index.js';
import { getCrmDb, closeCrmDb } from '$lib/crm/index.js';
import { getFetchPageDb, closeFetchPageDb } from '$lib/fetch-page/index.js';
import { initAgentsWatcher, shutdownAgentsWatcher } from '$lib/agents/watcher.js';
import { seedDefaultsIfEmpty } from '$lib/explorer-roots.js';
import { soulHubDataDir, soulHubSettingsPath } from '$lib/paths.js';
import '$lib/secrets.js'; // Load platform secrets into process.env at startup
import { existsSync } from 'node:fs';

const DATA_DIR = soulHubDataDir();

// Seed file-explorer roots on first run with the previously-hardcoded paths
// so existing flows (vault attachments, project file browsers) keep working
// without manual setup.
try {
	seedDefaultsIfEmpty([
		{ name: 'Dev', path: config.paths.devDir },
		{ name: 'Vault', path: config.paths.vaultDir },
	]);
} catch (err) {
	console.error('[explorer-roots] Failed to seed defaults:', err);
}

// Initialize vault engine (block server until vault is ready)
try {
	await initVault(config.resolved.vaultDir);
} catch (err) {
	console.error('[vault] Failed to initialize:', err);
}

// Initialize system health (detect → heal → notify loop)
try {
	await initSystemHealth(DATA_DIR, config.resolved.vaultDir);
} catch (err) {
	console.error('[system-health] Failed to initialize:', err);
}

// Initialize inbox database + start sync workers
try {
	getInboxDb();
	startSync().then(() => console.log('[inbox] Sync workers started'))
		.catch((err) => console.error('[inbox] Sync start failed:', err));
	// Layer 2 filter worker — ADR 2026-05-11-inbox-processing-filter-layer.
	// Fire-and-forget: auth probe + cold-start may take minutes; we don't
	// want SvelteKit boot to wait. The interval is scheduled inside
	// startFilterWorker() only after cold-start completes.
	startFilterWorker().then(() => console.log('[inbox] Filter worker started'))
		.catch((err) => console.error('[inbox] Filter start failed:', err));
	// Layer 3 Stage 4 auto-route worker — ADR §D5. Idempotent; honors
	// INBOX_AGENT_DISABLED / INBOX_AUTO_ROUTE_DISABLED / cfg.inbox.autoRoute.enabled
	// internally so an unconfigured operator never has rows routed by surprise.
	startAutoRouteWorker(() => config.inbox.autoRoute);
	console.log('[inbox] Database initialized');
} catch (err) {
	console.error('[inbox] Failed to initialize:', err);
}

// Initialize CRM database — ADR 2026-05-11-crm-local-sqlite-transition Stage A.
// Schema-only ship; tools / API / UI follow in later stages. Cheap call
// (file open + migration check) so we run it inline.
try {
	getCrmDb();
	console.log('[crm] Database initialized');
} catch (err) {
	console.error('[crm] Failed to initialize:', err);
}

// Initialize fetch_page database — ADR 2026-05-11-fetch-page-tool.
// Instruments every fetchPage call for the Stagehand resurface decision
// (≥10 distinct js-required hosts over 30 days → resurface trigger).
try {
	getFetchPageDb();
	console.log('[fetch-page] Database initialized');
} catch (err) {
	console.error('[fetch-page] Failed to initialize:', err);
}

// Start agents lane watcher (Phase 2 — bumps store version on file change)
try {
	initAgentsWatcher();
} catch (err) {
	console.error('[agents/watcher] Failed to initialize:', err);
}

// Register built-in task handlers. Must happen BEFORE initSchedulerCore
// so reconcileFromSettings finds the handlers when it walks the task
// list. New task types (Phase 3+) register here too.
try {
	registerTaskHandler(
		'shell-script',
		shellScriptFactory,
		'Run an arbitrary shell command (e.g. python script) on a cron schedule.',
	);
	registerTaskHandler(
		'daily-focus',
		dailyFocusFactory,
		'Mon-Fri morning focus picker — Slot A (freshest active) + Slot B (oldest stalled).',
	);
	registerTaskHandler(
		'vault-scout',
		vaultScoutFactory,
		'Daily AI-driven vault scout — extracts milestones, synthesizes via Gemini Flash, queues voice-eligible inbox notes.',
	);
	registerTaskHandler(
		'inbox-digest',
		inboxDigestFactory,
		'Daily inbox digest — server-formatted summary of queued mail from the lookback window, excludes already anomaly-pushed rows (Layer 3 Stage 3b).',
	);
	registerTaskHandler(
		'inbox-digest-telegram',
		inboxDigestTelegramFactory,
		'ADR-044 — Telegram-native inbox digest with inline action buttons (Save/Archive/Mute/Draft reply).',
	);
	registerTaskHandler(
		'inbox-anomaly-telegram',
		inboxAnomalyTelegramFactory,
		'ADR-044.H — Telegram-native S3a anomaly push (replaces WhatsApp anomaly rail). Same 4-button keyboard as the digest.',
	);
	registerTaskHandler(
		'intent-mining',
		intentMiningFactory,
		'Daily intent analyst (ADR-023 P1.5) — mines intent_log + chat_history and proposes routing patterns for operator approval.',
	);
	registerTaskHandler(
		'telegram-liveness',
		telegramLivenessFactory,
		'Telegram webhook liveness check (ADR-011 falsifier #5) — calls getWebhookInfo and alerts on pending_update_count > threshold or recent delivery errors.',
	);
	registerTaskHandler(
		'hygiene-button-escalator',
		hygieneButtonEscalatorFactory,
		'Weekly inline-button escalator (ADR-042 pass 2) — runs 1 min after project-hygiene script; reads the fresh digest and sends one Telegram inline-keyboard message per archive_zone_mismatch row.',
	);
} catch (err) {
	console.error('[scheduler] handler registration failed:', err);
}

// Initialize the unified scheduler (sweep stale rows → reconcile from
// settings → run catchup-on-boot).
(async () => {
	try {
		const result = await initSchedulerCore(config.scheduler);
		console.log(
			`[scheduler] init: registered=${result.reconcile.registered.length} ` +
				`skipped=${result.reconcile.skipped.length} ` +
				`swept=${result.swept} catchupFired=${result.catchupFired}`,
		);
	} catch (err) {
		console.error('[scheduler] Failed to initialize:', err);
	}
})();

// Recover interrupted orchestration runs on startup
(async () => {
	try {
		const { recoverRuns } = await import('$lib/orchestration/conductor.js');
		const result = await recoverRuns();
		if (result.recovered > 0) {
			console.log(
				`[orchestration] Startup recovery: ${result.recovered} runs, ${result.interrupted} workers interrupted`,
			);
		}
	} catch (err) {
		console.error('[orchestration] Startup recovery failed:', err);
	}
})();

// Graceful shutdown handler for PM2 reload/restart
function gracefulShutdown(signal: string) {
	console.log(`[soul-hub] ${signal} received — draining connections...`);

	const activeIds = listSessions();
	for (const id of activeIds) {
		killSession(id);
	}
	console.log(`[soul-hub] Cleaned up ${activeIds.length} PTY sessions`);

	// Shutdown system health (stop health loop)
	const systemHealth = getSystemHealth();
	if (systemHealth) systemHealth.shutdown();

	// Shutdown inbox sync + filter + auto-route workers, then close database.
	stopSync().catch(() => {});
	stopFilterWorker().catch(() => {});
	stopAutoRouteWorker();
	closeInboxDb();

	// Close CRM database (no workers — schema-only at Stage A).
	closeCrmDb();

	// Close fetch_page log database.
	closeFetchPageDb();

	// Shutdown vault engine (stop file watcher)
	const vault = getVaultEngine();
	if (vault) vault.shutdown();

	// Stop the agents-lane watcher (close chokidar handles cleanly)
	shutdownAgentsWatcher().catch(() => {});

	// Stop every cron task so PM2 reload doesn't leak intervals.
	shutdownScheduler();

	// Cleanup orchestration workers (async, best-effort)
	(async () => {
		try {
			const { listRuns } = await import('$lib/orchestration/board.js');
			const { killWorkerAsync } = await import('$lib/orchestration/conductor.js');
			const runs = await listRuns(100);
			let orchCount = 0;
			for (const run of runs) {
				if (run.status !== 'running' && run.status !== 'approved') continue;
				for (const [taskId, worker] of Object.entries(run.workers)) {
					if (worker.status === 'running') {
						await killWorkerAsync(run.runId, taskId).catch(() => {});
						orchCount++;
					}
				}
			}
			if (orchCount > 0) console.log(`[soul-hub] Cleaned up ${orchCount} orchestration workers`);
		} catch {
			// Orchestration module may not be ready — skip
		}
	})();

	// Give SSE clients time to receive disconnect
	setTimeout(() => {
		console.log(`[soul-hub] Shutdown complete`);
		process.exit(0);
	}, 2000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Defense-in-depth gate for /api/files/*. Blocks cross-site reads (the
 * realistic CSRF / exfiltration threat) while leaving legit same-origin
 * fetches from the SvelteKit frontend untouched. API clients (curl,
 * scripts) authenticate explicitly via Authorization: Bearer ${SOUL_HUB_SECRET}.
 *
 * Why this works without a session: Sec-Fetch-Site is set by the browser
 * and can't be forged from JS, so a malicious page embedding
 * <img src="https://soul-hub../api/files?action=raw..."> sends
 * `Sec-Fetch-Site: cross-site` and gets rejected.
 */
function checkFileApiAccess(request: Request): { ok: true } | { ok: false; reason: string } {
	const auth = request.headers.get('authorization') || '';
	const secret = process.env.SOUL_HUB_SECRET;
	if (secret && auth === `Bearer ${secret}`) return { ok: true };

	const fetchSite = request.headers.get('sec-fetch-site');
	// Allowed: same-origin (page fetch), same-site (subdomain), none (direct navigation / SSR fetch).
	// Rejected: cross-site (third-party origin).
	if (fetchSite === 'cross-site') {
		return { ok: false, reason: 'cross-site requests must use Authorization: Bearer header' };
	}
	return { ok: true };
}

/**
 * ADR-016 — map old top-level orchestration URLs to their new
 * `/orchestration/*` equivalents. Returns the new path+search if a
 * redirect is needed, or null otherwise. Order is significant: the
 * `/agents/orchestrator` exact match wins before the `/agents` prefix.
 *
 * API routes (`/api/agents`, `/api/skills`) are NOT redirected — only
 * page URLs moved.
 */
function redirectOrchestration(pathname: string, search: string): string | null {
	// Exact rewrite: /agents/orchestrator → /orchestration/metrics
	if (pathname === '/agents/orchestrator') {
		return '/orchestration/metrics' + search;
	}
	// Prefix rewrite: /agents → /orchestration/agents (covers /, /new, /[id]/runs, etc.)
	if (pathname === '/agents' || pathname.startsWith('/agents/')) {
		return '/orchestration' + pathname + search;
	}
	// Prefix rewrite: /skills → /orchestration/skills (covers /, /install)
	if (pathname === '/skills' || pathname.startsWith('/skills/')) {
		return '/orchestration' + pathname + search;
	}
	// Exact + prefix rewrite: /orchestrator/tools → /orchestration/tools
	if (pathname === '/orchestrator/tools' || pathname.startsWith('/orchestrator/tools/')) {
		return '/orchestration/tools' + pathname.slice('/orchestrator/tools'.length) + search;
	}
	return null;
}

/**
 * ADR-037 — code-workspace pages renamed from `/projects` + `/project/[name]`
 * to `/workspaces` + `/workspace/[name]`. The old `/projects` URL is now
 * the managed-initiative home (vault projects), so we DO NOT redirect it.
 * Only the per-workspace detail URL and the API are redirected.
 */
function redirectWorkspaces(pathname: string, search: string): string | null {
	// Exact + prefix: /project/foo → /workspace/foo (workspace detail pages)
	if (pathname === '/project' || pathname.startsWith('/project/')) {
		return '/workspace' + pathname.slice('/project'.length) + search;
	}
	// API rewrite: /api/projects[/...] → /api/workspaces[/...] (any cached fetch
	// from a stale page bundle keeps working until the operator hard-refreshes)
	if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
		return '/api/workspaces' + pathname.slice('/api/projects'.length) + search;
	}
	return null;
}

// Dev port proxy — intercept pXXXX.soul-hub.jneaimi.com before SvelteKit router
export const handle: Handle = async ({ event, resolve: svelteResolve }) => {
	const hostname = event.request.headers.get('host') || '';
	const proxyPort = extractProxyPort(hostname);

	if (process.env.DEBUG) {
		console.log(`[proxy-debug] host="${hostname}" url="${event.request.url}" port=${proxyPort}`);
	}

	if (proxyPort !== null) {
		console.log(`[proxy] ${hostname} → localhost:${proxyPort} ${event.request.method} ${new URL(event.request.url).pathname}`);
		return proxyRequest(event.request, proxyPort);
	}

	const pathname = event.url.pathname;

	// ADR-016 — 301 redirects for the old orchestration cluster URLs.
	// Order matters: more-specific prefixes first so `/agents/orchestrator`
	// doesn't get rewritten to `/orchestration/agents/orchestrator`.
	const orchestrationRedirect = redirectOrchestration(pathname, event.url.search);
	if (orchestrationRedirect) {
		return new Response(null, { status: 301, headers: { location: orchestrationRedirect } });
	}

	// ADR-037 — 301 redirects for the workspace pages (renamed from /project/*).
	// /projects is intentionally NOT redirected because that URL now hosts the
	// new managed-initiative page. Operators with bookmarks to /projects will
	// see the new page, which is the desired V1 behaviour.
	const workspacesRedirect = redirectWorkspaces(pathname, event.url.search);
	if (workspacesRedirect) {
		return new Response(null, { status: 301, headers: { location: workspacesRedirect } });
	}

	// First-run gate: if ~/.soul-hub/settings.json is missing, redirect HTML
	// page loads to /setup. API requests and asset fetches pass through so the
	// wizard itself can call /api/settings, /api/secrets, and load its bundle.
	// The check is gated on `Accept: text/html` so only top-level navigations
	// see the redirect — fetch/XHR responses stay normal.
	if (!pathname.startsWith('/setup')) {
		const accept = event.request.headers.get('accept') || '';
		const isHtmlNav = accept.includes('text/html');
		if (isHtmlNav && !existsSync(soulHubSettingsPath())) {
			return new Response(null, { status: 302, headers: { location: '/setup' } });
		}
	}

	if (pathname.startsWith('/api/files') || pathname.startsWith('/api/settings/explorer-roots')) {
		const check = checkFileApiAccess(event.request);
		if (!check.ok) {
			return new Response(JSON.stringify({ error: 'Unauthorized', reason: check.reason }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	return svelteResolve(event);
};
