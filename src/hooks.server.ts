import type { Handle } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { initScheduler } from '$lib/pipeline/index.js';
import { initVault, getVaultEngine } from '$lib/vault/index.js';
import { initSystemHealth, getSystemHealth } from '$lib/system/index.js';
import { listSessions, killSession } from '$lib/pty/manager.js';
import { extractProxyPort, proxyRequest } from '$lib/proxy.js';
import { getInboxDb, closeInboxDb, startSync, stopSync } from '$lib/inbox/index.js';
import '$lib/secrets.js'; // Load platform secrets into process.env at startup

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');
const DATA_DIR = resolve(dirname(config.resolved.catalogDir), '.data');

// Initialize scheduler on server startup
initScheduler(PIPELINES_DIR, DATA_DIR);

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

	return svelteResolve(event);
};
