import type { Handle } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';
import { initScheduler } from '$lib/pipeline/index.js';
import { initVault, getVaultEngine } from '$lib/vault/index.js';
import { listSessions, killSession } from '$lib/pty/manager.js';
import { extractProxyPort, proxyRequest } from '$lib/proxy.js';
import '$lib/secrets.js'; // Load platform secrets into process.env at startup

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');
const DATA_DIR = resolve(dirname(config.resolved.catalogDir), '.data');

// Initialize scheduler on server startup
initScheduler(PIPELINES_DIR, DATA_DIR);

// Initialize vault engine (fire-and-forget — endpoints return 503 until ready)
initVault(config.resolved.vaultDir).catch(err => {
	console.error('[vault] Failed to initialize:', err);
});

// Graceful shutdown handler for PM2 reload/restart
function gracefulShutdown(signal: string) {
	console.log(`[soul-hub] ${signal} received — draining connections...`);

	const activeIds = listSessions();
	for (const id of activeIds) {
		killSession(id);
	}
	console.log(`[soul-hub] Cleaned up ${activeIds.length} PTY sessions`);

	// Shutdown vault engine (stop file watcher)
	const vault = getVaultEngine();
	if (vault) vault.shutdown();

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
