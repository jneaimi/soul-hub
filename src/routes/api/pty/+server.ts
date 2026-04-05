import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const HOME = process.env.HOME || '';
const BRIDGE_SCRIPT = resolve(HOME, 'dev', 'soul-hub', 'scripts', 'pty_bridge.py');

// Active PTY sessions
const sessions = new Map<string, ChildProcess>();

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const action = body.action || 'spawn';

	if (action === 'input') {
		const { sessionId, data } = body;
		const bridge = sessions.get(sessionId);
		if (!bridge?.stdin?.writable) {
			return json({ error: 'Session not found' }, { status: 404 });
		}
		bridge.stdin.write(JSON.stringify({ type: 'input', data }) + '\n');
		return json({ ok: true });
	}

	if (action === 'resize') {
		const { sessionId, cols, rows } = body;
		const bridge = sessions.get(sessionId);
		if (!bridge?.stdin?.writable) {
			return json({ error: 'Session not found' }, { status: 404 });
		}
		bridge.stdin.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n');
		return json({ ok: true });
	}

	if (action === 'kill') {
		const { sessionId } = body;
		const bridge = sessions.get(sessionId);
		if (bridge) {
			bridge.stdin?.write(JSON.stringify({ type: 'kill' }) + '\n');
			bridge.kill();
			sessions.delete(sessionId);
		}
		return json({ ok: true });
	}

	// action === 'spawn'
	const { prompt, cwd, cols, rows } = body;

	if (!prompt?.trim()) {
		return json({ error: 'Missing prompt' }, { status: 400 });
	}

	const sessionId = crypto.randomUUID().slice(0, 8);

	const bridgeArgs = JSON.stringify({
		prompt,
		cwd: cwd || HOME,
		cols: cols || 120,
		rows: rows || 40,
	});

	const bridge = spawn('python3', [BRIDGE_SCRIPT, bridgeArgs], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			PATH: `${HOME}/.local/bin:${process.env.PATH}`,
		},
	});

	sessions.set(sessionId, bridge);

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`));

			const rl = createInterface({ input: bridge.stdout! });

			rl.on('line', (line) => {
				try {
					JSON.parse(line); // validate
					controller.enqueue(encoder.encode(`data: ${line}\n\n`));
				} catch { /* skip non-JSON */ }
			});

			bridge.stderr!.on('data', (data) => {
				console.error(`[pty:${sessionId}] ${data.toString().trim()}`);
			});

			bridge.on('exit', (code) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'exit', code: code || 0 })}\n\n`));
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
				sessions.delete(sessionId);
			});

			request.signal.addEventListener('abort', () => {
				bridge.kill();
				sessions.delete(sessionId);
			});
		},
		cancel() {
			bridge.kill();
			sessions.delete(sessionId);
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};

/** GET /api/pty — list active sessions */
export const GET: RequestHandler = async () => {
	const active = Array.from(sessions.keys());
	return json({ sessions: active, count: active.length });
};
