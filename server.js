/**
 * Custom server wrapper for Soul Hub.
 * Intercepts requests BEFORE SvelteKit's static asset handler,
 * enabling the port proxy to work for ALL paths (including /_app/).
 */

import http from 'node:http';
import { handler } from './build/handler.js';

const PORT = parseInt(process.env.PORT || '2400');

// Lazy-load proxy module from the build output
let proxyModule = null;
async function getProxy() {
	if (!proxyModule) {
		// Import the built hooks which contain extractProxyPort and proxyRequest
		const hooks = await import('./build/server/chunks/hooks.server.js').catch(() => null);
		if (!hooks) {
			// Fallback: inline the proxy logic
			const { request: httpRequest } = await import('node:http');
			const settingsJson = await import('node:fs').then(fs =>
				JSON.parse(fs.readFileSync(new URL('./settings.json', import.meta.url), 'utf-8'))
			);
			const proxyConfig = settingsJson.proxy || { enabled: true, allowedPortRange: [1024, 9999], blockedPorts: [2400] };
			const PORT_RE = /^p(\d+)\./;

			proxyModule = {
				extractPort(hostname) {
					if (!proxyConfig.enabled) return null;
					const m = hostname.match(PORT_RE);
					if (!m) return null;
					const port = parseInt(m[1], 10);
					const [min, max] = proxyConfig.allowedPortRange;
					if (port < min || port > max) return null;
					if (proxyConfig.blockedPorts.includes(port)) return null;
					return port;
				},
				proxy(req, res, targetPort) {
					const fwdHeaders = { ...req.headers };
					const originalHost = fwdHeaders.host || '';
					const originalReferer = fwdHeaders.referer;
					fwdHeaders.host = `localhost:${targetPort}`;
					// Rewrite (don't strip) origin/referer — SvelteKit CSRF compares origin
					// to url.origin; stripping origin causes `undefined !== 'http://localhost:PORT'`.
					fwdHeaders.origin = `http://localhost:${targetPort}`;
					if (originalReferer) {
						try {
							const refUrl = new URL(originalReferer);
							fwdHeaders.referer = `http://localhost:${targetPort}${refUrl.pathname}${refUrl.search}`;
						} catch { delete fwdHeaders.referer; }
					}
					fwdHeaders['x-forwarded-host'] = originalHost;
					fwdHeaders['x-forwarded-proto'] = 'https';

					const proxyReq = httpRequest({
						hostname: 'localhost',
						port: targetPort,
						path: req.url,
						method: req.method,
						headers: fwdHeaders,
					}, (proxyRes) => {
						res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
						proxyRes.pipe(res);
					});

					proxyReq.on('error', (err) => {
						res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
						res.end(`<html><body style="font-family:system-ui;padding:2rem">
<h1>502 Bad Gateway</h1>
<p>Could not reach <code>localhost:${targetPort}</code></p>
<p style="color:#666">${err.message}</p>
<p>Make sure a dev server is running on port ${targetPort}.</p>
</body></html>`);
					});

					proxyReq.setTimeout(30000, () => {
						proxyReq.destroy(new Error('Proxy request timed out'));
					});

					req.pipe(proxyReq);
				}
			};
		}
	}
	return proxyModule;
}

const server = http.createServer(async (req, res) => {
	const host = req.headers.host || '';
	const proxy = await getProxy();

	if (proxy) {
		const targetPort = proxy.extractPort(host);
		if (targetPort !== null) {
			return proxy.proxy(req, res, targetPort);
		}
	}

	// Not a proxy request — pass to SvelteKit
	handler(req, res);
});

// WebSocket upgrade for proxied dev servers (HMR support)
server.on('upgrade', async (req, socket, head) => {
	const host = req.headers.host || '';
	const proxy = await getProxy();

	if (proxy) {
		const targetPort = proxy.extractPort(host);
		if (targetPort !== null) {
			const { request: httpRequest } = await import('node:http');
			const fwdHeaders = { ...req.headers };
			fwdHeaders.host = `localhost:${targetPort}`;
			delete fwdHeaders.origin;

			const proxyReq = httpRequest({
				hostname: 'localhost',
				port: targetPort,
				path: req.url,
				method: req.method,
				headers: fwdHeaders,
			});

			proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\n` +
					Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
					'\r\n\r\n'
				);
				if (proxyHead.length) socket.write(proxyHead);
				proxySocket.pipe(socket);
				socket.pipe(proxySocket);
			});

			proxyReq.on('error', () => socket.destroy());
			proxyReq.end();
			return;
		}
	}

	// Not a proxy request — SvelteKit doesn't handle WebSocket, just close
	socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
	console.log(`Listening on http://0.0.0.0:${PORT}`);
});
