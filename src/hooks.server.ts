import type { Handle } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { initScheduler } from '$lib/pipeline/index.js';
import { initVault, getVaultEngine } from '$lib/vault/index.js';
import { initSystemHealth, getSystemHealth } from '$lib/system/index.js';
import { listSessions, killSession } from '$lib/pty/manager.js';
import { extractProxyPort, proxyRequest } from '$lib/proxy.js';
import { getInboxDb, closeInboxDb, startSync, stopSync } from '$lib/inbox/index.js';
import { seedDefaultsIfEmpty } from '$lib/explorer-roots.js';
import '$lib/secrets.js'; // Load platform secrets into process.env at startup

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');
const DATA_DIR = resolve(dirname(config.resolved.catalogDir), '.data');

// Initialize scheduler on server startup
initScheduler(PIPELINES_DIR, DATA_DIR);

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
	console.log('[inbox] Database initialized');
} catch (err) {
	console.error('[inbox] Failed to initialize:', err);
}

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

	// Shutdown inbox sync workers + database
	stopSync().catch(() => {});
	closeInboxDb();

	// Shutdown vault engine (stop file watcher)
	const vault = getVaultEngine();
	if (vault) vault.shutdown();

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
