/**
 * Lane A1 dispatcher — interactive Claude Code session over a PTY.
 *
 * Reuses `src/lib/pty/manager.ts` (`spawnSession`/`killSession`), which
 * handles workspace-trust prompts, prompt injection, and ANSI stripping.
 * On top of that we add:
 *   - **`--agent <id>` profile loading** so Claude Code pulls
 *     `system_prompt` from `~/.claude/agents/<id>.md` itself. Pre-pasting
 *     a >100-line system prompt as user input fragments into multiple
 *     `[Pasted text #N]` preview blocks that never auto-confirm — the
 *     agent stalls in the splash and never executes (see learning
 *     `2026-05-06-pty-paste-stall-and-agent-flag`). Typed input now
 *     stays short: just conversation context + the task.
 *   - **Adaptive stall detection** — `STALL_MS_DEFAULT` (30s) is fine for
 *     chat-shaped agents but too tight for tool-call-heavy work (image
 *     gen, web fetch). `resolveStallMs(budget)` scales to `timeout_ms/8`
 *     up to `STALL_MS_MAX` (120s).
 *   - Hard timeout from the resolved budget.
 *   - MCP isolation flags so the agent can't trip user-scoped auth prompts.
 *
 * Test mode delegates to `claude -p --agent <id>` for a clean text reply.
 * The agent definition lives in the same `.md` file in Lane A, so the test
 * exercises the same prompt; we just bypass the interactive TUI rendering
 * because chat-to-test users want readable output, not ANSI-coloured status
 * bars. Production dispatches still use the PTY path for parallel safety.
 *
 * Production v1 ships without worktree isolation; the agent runs in vaultDir
 * and writes there. Code-writing agents stay in the orchestration engine
 * until ADR-001's worktree mode lands.
 */

import { spawnSession, killSession } from '$lib/pty/manager.js';
import { config } from '$lib/config.js';
import type { AgentSummary } from '../types.js';
import type { BackendDispatcher, DispatchEvent, DispatchOptions, DispatchResult } from './types.js';
import { resolveBudget } from './budget.js';
import { claudeCliFlagDispatcher } from './claude-cli-flag.js';

/** Default silence-after-activity threshold before treating the session as
 *  done. 30s is fine for chat-shaped agents that emit progress text every
 *  few seconds; tool-call-heavy agents (image gen, web fetch) can sit idle
 *  for 30-60s on a single API call. Scaled per-agent below by
 *  `resolveStallMs(budget)` so a 600s-budget agent gets 75s before stall. */
const STALL_MS_DEFAULT = 30_000;
/** Cap on the scaled stall — past this, stall starts overlapping the hard
 *  timeout and we'd never preempt a genuinely stuck session. */
const STALL_MS_MAX = 120_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function resolveStallMs(timeoutMs: number): number {
	const scaled = Math.floor(timeoutMs / 8);
	return Math.min(STALL_MS_MAX, Math.max(STALL_MS_DEFAULT, scaled));
}

export const claudePtyDispatcher: BackendDispatcher = {
	id: 'claude-pty',

	async *dispatch(
		agent: AgentSummary,
		opts: DispatchOptions,
	): AsyncGenerator<DispatchEvent, DispatchResult, void> {
		// Chat-to-test runs route through headless `claude -p` so the user sees
		// the agent's actual reply, not the full TUI. Same Max auth, same agent
		// definition file, same backend identity in the result envelope.
		if (opts.mode === 'test') {
			const result = yield* claudeCliFlagDispatcher.dispatch(agent, opts);
			return { ...result, backend: 'claude-pty' };
		}

		const runId = crypto.randomUUID().slice(0, 8);
		const started = Date.now();
		const budget = resolveBudget(opts.mode, agent.budget);
		const stallMs = resolveStallMs(budget.timeout_ms);

		const prompt = composePrompt(opts.task, opts.context);
		const model = agent.model || 'sonnet';

		let session;
		try {
			session = spawnSession({
				prompt,
				agentId: agent.id, // Claude Code loads system_prompt from ~/.claude/agents/<id>.md
				cwd: config.resolved.vaultDir,
				shell: false,
				model,
				extraArgs: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
			});
		} catch (err) {
			const msg = (err as Error).message;
			yield { type: 'error', message: msg, ts: Date.now() };
			return finish(runId, agent, started, 'error', '', msg);
		}

		yield { type: 'started', backend: 'claude-pty', model, runId, ts: started };

		// Buffer stdout chunks and a stripped accumulator for the final result.
		const queue: string[] = [];
		let combined = '';
		let lastActivity = Date.now();
		let exited = false;
		let exitCode: number | null = null;
		let promptInjected = false;

		const onOutput = (data: string) => {
			lastActivity = Date.now();
			queue.push(data);
			combined += data;
		};
		const onExit = (code: number) => {
			exited = true;
			exitCode = code;
		};
		const onPromptSent = () => {
			promptInjected = true;
			lastActivity = Date.now();
		};

		session.emitter.on('output', onOutput);
		session.emitter.on('exit', onExit);
		session.emitter.on('prompt_sent', onPromptSent);

		const onAbort = () => {
			killSession(session.id);
		};
		opts.signal?.addEventListener('abort', onAbort);

		try {
			let stalled = false;
			let timedOut = false;

			while (!exited) {
				while (queue.length > 0) {
					const chunk = queue.shift()!;
					yield { type: 'output', data: chunk, ts: Date.now() };
				}

				const elapsed = Date.now() - started;
				const idle = Date.now() - lastActivity;

				if (elapsed >= budget.timeout_ms) {
					timedOut = true;
					killSession(session.id);
					break;
				}
				if (promptInjected && idle >= stallMs) {
					stalled = true;
					killSession(session.id);
					break;
				}
				if (opts.signal?.aborted) break;

				await new Promise((r) => setTimeout(r, 200));
			}

			// Flush any final buffered chunks
			while (queue.length > 0) {
				const chunk = queue.shift()!;
				yield { type: 'output', data: chunk, ts: Date.now() };
			}

			const cleaned = stripAnsi(combined).trim();

			if (opts.signal?.aborted) {
				return finish(runId, agent, started, 'cancelled', cleaned, 'cancelled');
			}
			if (timedOut) {
				const msg = `Dispatch exceeded ${budget.timeout_ms}ms timeout`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'timeout', cleaned, msg);
			}
			if (stalled) {
				// Stall is expected when the model is done and waiting for input.
				return finish(runId, agent, started, 'success', cleaned);
			}
			// 129 = SIGHUP on macOS, treated as success per orchestration engine.
			const ok = exitCode === 0 || exitCode === 129;
			if (!ok) {
				const msg = `PTY exited ${exitCode}`;
				yield { type: 'error', message: msg, ts: Date.now() };
				return finish(runId, agent, started, 'error', cleaned, msg);
			}
			return finish(runId, agent, started, 'success', cleaned);
		} finally {
			session.emitter.off('output', onOutput);
			session.emitter.off('exit', onExit);
			session.emitter.off('prompt_sent', onPromptSent);
			opts.signal?.removeEventListener('abort', onAbort);
			killSession(session.id);
		}
	},
};

/** Compose the user-message-shaped prompt that gets typed into Claude Code's
 *  TUI. The agent's `system_prompt` is loaded by Claude Code from
 *  `~/.claude/agents/<id>.md` via the `--agent <id>` flag — DO NOT
 *  pre-paste it here. Pasting >100 lines fragments into multiple
 *  `[Pasted text #N]` preview blocks that never auto-confirm and the
 *  agent stalls until the idle timer kicks in.
 *
 *  Keep this short: just the conversational context (when present) and
 *  the task instruction. ~600-1000 chars typical. */
function composePrompt(task: string, context?: string): string {
	const ctx = context?.trim();
	if (!ctx) return task;
	return `${ctx}\n\n---\n\n# Task\n\n${task}`;
}

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '');
}

function finish(
	runId: string,
	agent: AgentSummary,
	started: number,
	status: DispatchResult['status'],
	output: string,
	error?: string,
): DispatchResult {
	return {
		runId,
		agentId: agent.id,
		backend: agent.backend,
		status,
		output,
		cost_usd: 0, // PTY runs use Max subscription — no per-call cost
		num_turns: 0, // not tracked in PTY mode
		duration_ms: Date.now() - started,
		error,
	};
}
