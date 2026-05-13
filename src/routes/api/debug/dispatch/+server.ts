/**
 * POST /api/debug/dispatch — temporary production-mode dispatch endpoint.
 *
 * Added 2026-05-13 to validate ADR-031 v2 goal-mode end-to-end on
 * `developer` and `security-reviewer`. The existing `/api/agents/[id]/test`
 * forces `mode: 'test'`, which routes through `claude-cli-flag` and
 * silently ignores `goal_condition` (no `--goal` on `claude -p` in
 * v2.1.139). Goal-mode only activates on `mode: 'production'`, which has
 * no operator-driven HTTP entry point today; this route fills that gap
 * for live validation.
 *
 * Auth: `Authorization: Bearer <DEBUG_DISPATCH_TOKEN>` — fail-closed if
 * the env var is not set, per the project's webhook-security pattern.
 *
 * Body: `{ agentId: string, task: string }`
 *
 * Streams NDJSON, same envelope shape as `/api/agents/[id]/test`.
 *
 * Remove this file once the validation campaign completes.
 */

import { error, type RequestHandler } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { dispatchAgent } from '$lib/agents/dispatch/index.js';
import { getAgent } from '$lib/agents/store.js';

function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const POST: RequestHandler = async ({ request }) => {
	const secret = process.env.DEBUG_DISPATCH_TOKEN;
	if (!secret) {
		throw error(403, 'DEBUG_DISPATCH_TOKEN not configured — endpoint disabled');
	}

	// Canonical Bearer parse — explicit prefix check, then slice. Matches
	// the project's webhook-security pattern (replace('Bearer ', '') would
	// silently accept a bare token without the prefix).
	const auth = request.headers.get('authorization') ?? '';
	if (!auth.startsWith('Bearer ')) {
		throw error(401, 'unauthorized');
	}
	const headerToken = auth.slice('Bearer '.length);
	if (!headerToken || !safeCompare(headerToken, secret)) {
		throw error(401, 'unauthorized');
	}

	const body = (await request.json().catch(() => ({}))) as {
		agentId?: unknown;
		task?: unknown;
	};
	const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
	const task = typeof body.task === 'string' ? body.task.trim() : '';
	if (!agentId || !/^[a-z0-9][a-z0-9_-]*$/.test(agentId)) {
		throw error(400, 'invalid agentId');
	}
	if (!task) throw error(400, 'task is required (non-empty string)');
	if (task.length > 4000) throw error(400, 'task too long (max 4000 chars)');

	const agent = getAgent(agentId);
	if (!agent) throw error(404, `agent '${agentId}' not found`);

	const ac = new AbortController();
	request.signal.addEventListener('abort', () => ac.abort());

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (line: string) => {
				try {
					controller.enqueue(encoder.encode(line + '\n'));
				} catch {
					/* downstream closed */
				}
			};

			try {
				const gen = dispatchAgent(agentId, task, { mode: 'production', signal: ac.signal });
				while (true) {
					const next = await gen.next();
					if (next.done) {
						send(JSON.stringify({ type: 'done', result: next.value, ts: Date.now() }));
						break;
					}
					send(JSON.stringify(next.value));
				}
			} catch (err) {
				send(
					JSON.stringify({
						type: 'error',
						message: (err as Error).message ?? 'dispatch failed',
						ts: Date.now(),
					}),
				);
			} finally {
				controller.close();
			}
		},
		cancel() {
			ac.abort();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'application/x-ndjson; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Accel-Buffering': 'no',
		},
	});
};
