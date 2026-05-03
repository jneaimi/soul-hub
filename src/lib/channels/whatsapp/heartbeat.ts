/** Proactive heartbeat — periodic main-session turn that decides whether
 *  to nudge the user via WhatsApp. OpenClaw pattern (see
 *  `~/vault/projects/soul-hub-brain/adr-001-architecture.md`).
 *
 *  Lifecycle:
 *    initHeartbeat()     — call once from adapter.bootstrap(). Wires the
 *                          schedule from current settings. Idempotent;
 *                          safe to call again after `reloadConfig()`.
 *    stopHeartbeat()     — clear the schedule (used on shutdown).
 *    triggerHeartbeat()  — manual run (the `/heartbeat now` slash command).
 */

import cron from 'node-cron';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import { parseProviderRef } from '../../llm/types.js';
import { getSocket } from './connection.js';
import { sendText } from './outbound.js';
import { workerSend } from './worker-client.js';
import { getSoulBody } from './soul-loader.js';
import { getHeartbeatChecklist, parseDurationMs, type HeartbeatTask } from './heartbeat-loader.js';
import { stripHeartbeatToken } from './heartbeat-ok.js';
import {
	appendLog,
	getDailyCount,
	getTaskLastRun,
	incrementDailyCount,
	setTaskLastRun,
	ymdInTimezone,
	type HeartbeatStatus,
} from './heartbeat-state.js';
import type { WhatsAppChannelConfig } from './types.js';

type HeartbeatConfig = WhatsAppChannelConfig['heartbeat'];

let activeCron: ReturnType<typeof cron.schedule> | null = null;
let activeInterval: ReturnType<typeof setInterval> | null = null;

const MUTE_HINT = "\n\n(reply 'mute 24h' to pause)";

function readChannelConfig(): WhatsAppChannelConfig | null {
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** "08:00" with a Date and IANA tz → minutes since local midnight. */
function timeStringToMinutes(time: string): number {
	const [h, m] = time.split(':').map(Number);
	return h * 60 + m;
}

function nowMinutesInTimezone(timezone: string, at = Date.now()): number {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	const [hh, mm] = fmt.format(new Date(at)).split(':').map(Number);
	return hh * 60 + mm;
}

function withinActiveHours(cfg: HeartbeatConfig, at = Date.now()): boolean {
	const start = timeStringToMinutes(cfg.activeHours.start);
	const end = timeStringToMinutes(cfg.activeHours.end);
	const now = nowMinutesInTimezone(cfg.activeHours.timezone, at);
	if (start === end) return false; // zero-width window
	if (start < end) return now >= start && now < end;
	// Wrap-around (e.g. 22:00 → 07:00).
	return now >= start || now < end;
}

function muteActive(cfg: HeartbeatConfig): boolean {
	if (!cfg.muteUntil) return false;
	const until = Date.parse(cfg.muteUntil);
	if (Number.isNaN(until)) return false;
	return Date.now() < until;
}

export interface HeartbeatRuntimeStatus {
	enabled: boolean;
	target: string | null;
	withinActiveHours: boolean;
	muteUntil: string | null;
	muteRemainingMs: number | null;
	dailyCount: number;
	dailyCap: number;
	soulPath: string;
	checklistPath: string;
	scheduleDescription: string;
}

/** Snapshot used by the Settings UI status line. Cheap — no LLM, no DB
 *  writes, just config + one daily-counter read. Safe to poll. */
export function getHeartbeatRuntimeStatus(): HeartbeatRuntimeStatus | null {
	const cfg = readChannelConfig();
	if (!cfg) return null;
	const hb = cfg.heartbeat;
	const ymd = ymdInTimezone(hb.activeHours.timezone);
	const dailyCount = hb.target ? getDailyCount(hb.target, ymd) : 0;
	const muteUntilMs = hb.muteUntil ? Date.parse(hb.muteUntil) : NaN;
	const muteRemainingMs =
		!Number.isNaN(muteUntilMs) && muteUntilMs > Date.now() ? muteUntilMs - Date.now() : null;
	return {
		enabled: hb.enabled,
		target: hb.target ?? null,
		withinActiveHours: withinActiveHours(hb),
		muteUntil: hb.muteUntil ?? null,
		muteRemainingMs,
		dailyCount,
		dailyCap: hb.maxPerDay,
		soulPath: hb.soulPath,
		checklistPath: hb.checklistPath,
		scheduleDescription: `every ${hb.every} within ${hb.activeHours.start}–${hb.activeHours.end} ${hb.activeHours.timezone}`,
	};
}

function targetToJid(e164: string): string {
	return `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
}

async function deliver(text: string, cfg: WhatsAppChannelConfig, target: string): Promise<{ ok: boolean; error?: string }> {
	const jid = targetToJid(target);
	if (cfg.worker.enabled) {
		const result = await workerSend(cfg.worker, { to: jid, text });
		return { ok: !!result?.ok, error: result?.error };
	}
	const sock = getSocket();
	if (!sock) return { ok: false, error: 'WhatsApp socket not connected' };
	const result = await sendText(sock, jid, text, cfg.delivery);
	return { ok: result.ok, error: result.error };
}

/** Pick the tasks whose interval has elapsed since their last run. */
function computeDueTasks(tasks: HeartbeatTask[], now = Date.now()): HeartbeatTask[] {
	return tasks.filter((t) => {
		const last = getTaskLastRun(t.name);
		if (last === undefined) return true;
		return now - last >= t.intervalMs;
	});
}

function buildUserPrompt(basePrompt: string, body: string, due: HeartbeatTask[]): string {
	const parts: string[] = [basePrompt];
	if (body.trim()) parts.push(body.trim());
	if (due.length > 0) {
		parts.push('\nDue tasks for this tick:\n');
		for (const t of due) {
			parts.push(`### ${t.name}\n${t.prompt}`);
		}
	}
	return parts.join('\n\n');
}

/** Call the configured LLM. v0 wires Gemini; CLI/OpenRouter/Anthropic
 *  surfaces a clear error so the operator knows where to extend. */
async function callModel(opts: {
	model: string;
	system: string;
	user: string;
	abortSignal?: AbortSignal;
}): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
	const { providerId, modelId } = parseProviderRef(opts.model);

	if (providerId === 'gemini') {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) {
			throw new Error('GEMINI_API_KEY is not set — heartbeat cannot run with provider "gemini".');
		}
		const client = createGoogleGenerativeAI({ apiKey });
		const result = await generateText({
			model: client(modelId),
			system: opts.system || undefined,
			prompt: opts.user,
			maxOutputTokens: 600,
			// Disable thinking: the heartbeat is a short ack/nudge, and 2.5
			// Flash will otherwise burn the entire output budget on hidden
			// reasoning, returning a truncated reply (e.g. "HEART" instead
			// of "HEARTBEAT_OK"). See feedback_gemini_thinking_budget.
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 0 } },
			},
			abortSignal: opts.abortSignal,
		});
		return {
			text: result.text,
			tokensIn: result.usage?.inputTokens,
			tokensOut: result.usage?.outputTokens,
		};
	}

	throw new Error(
		`Heartbeat model provider "${providerId}" is not wired yet. ` +
			'Default `gemini:gemini-2.5-flash` is supported. To use claude-cli/openrouter/anthropic, ' +
			'extend src/lib/channels/whatsapp/heartbeat.ts → callModel.',
	);
}

/** Run one heartbeat tick. Pure side effects: log + maybe deliver. */
export async function runHeartbeatOnce(
	source: 'scheduled' | 'manual' = 'scheduled',
): Promise<{ status: HeartbeatStatus; text?: string }> {
	const cfg = readChannelConfig();
	if (!cfg?.enabled || !cfg.heartbeat.enabled) {
		return { status: 'error' };
	}
	const hb = cfg.heartbeat;
	if (!hb.target) {
		appendLog({
			ts: Date.now(),
			target: '<unset>',
			status: 'error',
			text: 'heartbeat.target not configured',
		});
		return { status: 'error' };
	}

	// Gates — order matters. Manual runs skip active-hours/mute (the user
	// explicitly asked) but still respect the daily cap to prevent abuse.
	if (source === 'scheduled') {
		if (!withinActiveHours(hb)) {
			appendLog({ ts: Date.now(), target: hb.target, status: 'gated_active_hours' });
			return { status: 'gated_active_hours' };
		}
		if (muteActive(hb)) {
			appendLog({ ts: Date.now(), target: hb.target, status: 'gated_mute' });
			return { status: 'gated_mute' };
		}
	}
	const ymd = ymdInTimezone(hb.activeHours.timezone);
	if (getDailyCount(hb.target, ymd) >= hb.maxPerDay) {
		appendLog({ ts: Date.now(), target: hb.target, status: 'gated_cap' });
		return { status: 'gated_cap' };
	}

	// Empty checklist → no-op, no API call.
	const checklist = getHeartbeatChecklist(hb.checklistPath);
	const dueTasks = computeDueTasks(checklist.tasks);
	if (checklist.isEmpty || (checklist.tasks.length > 0 && dueTasks.length === 0 && !checklist.body.trim())) {
		appendLog({ ts: Date.now(), target: hb.target, status: 'skipped_empty' });
		return { status: 'skipped_empty' };
	}

	// Compose + call.
	const system = getSoulBody(hb.soulPath);
	const user = buildUserPrompt(hb.basePrompt, checklist.body, dueTasks);

	let modelResult: { text: string; tokensIn?: number; tokensOut?: number };
	try {
		modelResult = await callModel({ model: hb.model, system, user });
	} catch (err) {
		appendLog({
			ts: Date.now(),
			target: hb.target,
			status: 'error',
			text: (err as Error).message,
			model: hb.model,
		});
		return { status: 'error' };
	}

	const ack = stripHeartbeatToken(modelResult.text, { ackMaxChars: hb.ackMaxChars });

	// Advance task_state for every fired task whether or not we delivered —
	// the LLM has "considered" them this tick; re-running with the same
	// inputs would just produce the same ack.
	for (const t of dueTasks) {
		setTaskLastRun(t.name);
	}

	if (ack.shouldSkip) {
		appendLog({
			ts: Date.now(),
			target: hb.target,
			status: 'ack',
			text: modelResult.text.trim(),
			tokensIn: modelResult.tokensIn,
			tokensOut: modelResult.tokensOut,
			model: hb.model,
		});
		return { status: 'ack' };
	}

	const finalText = ack.cleanText + MUTE_HINT;
	const delivery = await deliver(finalText, cfg, hb.target);
	if (!delivery.ok) {
		appendLog({
			ts: Date.now(),
			target: hb.target,
			status: 'error',
			text: `delivery failed: ${delivery.error ?? 'unknown'}`,
			tokensIn: modelResult.tokensIn,
			tokensOut: modelResult.tokensOut,
			model: hb.model,
		});
		return { status: 'error' };
	}

	incrementDailyCount(hb.target, ymd);
	appendLog({
		ts: Date.now(),
		target: hb.target,
		status: 'sent',
		text: ack.cleanText,
		tokensIn: modelResult.tokensIn,
		tokensOut: modelResult.tokensOut,
		model: hb.model,
	});
	return { status: 'sent', text: ack.cleanText };
}

/** Manual trigger. Returns the run status; suitable for slash commands
 *  and HTTP wake endpoints. */
export async function triggerHeartbeat(): Promise<{ status: HeartbeatStatus; text?: string }> {
	return runHeartbeatOnce('manual');
}

function scheduleFromEvery(every: string): { kind: 'cron'; expr: string } | { kind: 'interval'; ms: number } | null {
	const trimmed = every.trim();
	// Cron expressions have whitespace separating fields.
	if (/\s/.test(trimmed)) {
		return cron.validate(trimmed) ? { kind: 'cron', expr: trimmed } : null;
	}
	const ms = parseDurationMs(trimmed);
	if (ms === null || ms < 1000) return null;
	return { kind: 'interval', ms };
}

/** Start (or restart) the heartbeat schedule from current settings.
 *  Idempotent — call after `reloadConfig()` to pick up changes. */
export function initHeartbeat(): void {
	stopHeartbeat();

	const cfg = readChannelConfig();
	if (!cfg?.enabled || !cfg.heartbeat.enabled) {
		return;
	}

	const schedule = scheduleFromEvery(cfg.heartbeat.every);
	if (!schedule) {
		console.warn(
			`[whatsapp/heartbeat] invalid 'every' value: ${cfg.heartbeat.every} — heartbeat not scheduled.`,
		);
		return;
	}

	const tick = () => {
		void runHeartbeatOnce('scheduled').catch((err) => {
			console.warn('[whatsapp/heartbeat] tick failed:', (err as Error).message);
		});
	};

	if (schedule.kind === 'cron') {
		activeCron = cron.schedule(schedule.expr, tick);
		console.log(`[whatsapp/heartbeat] scheduled (cron): ${schedule.expr}`);
	} else {
		activeInterval = setInterval(tick, schedule.ms);
		activeInterval.unref?.();
		console.log(`[whatsapp/heartbeat] scheduled (interval): ${schedule.ms}ms`);
	}
}

export function stopHeartbeat(): void {
	if (activeCron) {
		activeCron.stop();
		activeCron = null;
	}
	if (activeInterval) {
		clearInterval(activeInterval);
		activeInterval = null;
	}
}

export function isHeartbeatRunning(): boolean {
	return activeCron !== null || activeInterval !== null;
}
