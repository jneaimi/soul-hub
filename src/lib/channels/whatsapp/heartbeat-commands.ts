/** Heartbeat meta-commands — `/heartbeat now`, `/heartbeat status`,
 *  `/mute [duration]`, `/resume`. Routed before the standard intent map
 *  (mirroring the `/reset` precedent in `dispatch.ts`) because they
 *  control the channel itself, not chat content. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { soulHubSettingsPath } from '../../paths.js';
import { config as soulHubConfig, reloadConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import { parseDurationMs } from './heartbeat-loader.js';
import { initHeartbeat, triggerHeartbeat } from './heartbeat.js';
import { recentLog, getDailyCount, ymdInTimezone } from './heartbeat-state.js';
import type { WhatsAppChannelConfig } from './types.js';

function readChannelConfig(): WhatsAppChannelConfig | null {
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export function isHeartbeatMetaCommand(body: string): boolean {
	const trimmed = body.trim().toLowerCase();
	if (!trimmed) return false;
	const first = trimmed.split(/\s+/, 1)[0];
	return first === '/heartbeat' || first === '/mute' || first === '/resume';
}

/** Patch only `channels.whatsapp.heartbeat.<…>` in settings.json and
 *  reload. Atomic-ish: read → merge → write. Concurrent edits are not
 *  expected for a personal Soul Hub. */
async function mutateHeartbeat(patch: Record<string, unknown>): Promise<void> {
	const path = soulHubSettingsPath();
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(await readFile(path, 'utf-8'));
	} catch {
		/* start fresh */
	}

	const channels = (existing.channels as Record<string, unknown> | undefined) ?? {};
	const whatsapp = (channels.whatsapp as Record<string, unknown> | undefined) ?? {};
	const heartbeat = (whatsapp.heartbeat as Record<string, unknown> | undefined) ?? {};

	const merged = {
		...existing,
		channels: {
			...channels,
			whatsapp: {
				...whatsapp,
				heartbeat: { ...heartbeat, ...patch },
			},
		},
	};

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
	reloadConfig();
	// Re-apply the schedule (cadence/enabled/target may have changed).
	initHeartbeat();
}

function fmtCount(cfg: WhatsAppChannelConfig): string {
	const hb = cfg.heartbeat;
	if (!hb.target) return 'no target set';
	const ymd = ymdInTimezone(hb.activeHours.timezone);
	const used = getDailyCount(hb.target, ymd);
	return `${used}/${hb.maxPerDay} delivered today`;
}

function fmtMuteState(cfg: WhatsAppChannelConfig): string {
	const until = cfg.heartbeat.muteUntil;
	if (!until) return 'not muted';
	const ms = Date.parse(until);
	if (Number.isNaN(ms) || ms <= Date.now()) return 'mute expired';
	const remaining = ms - Date.now();
	const hours = Math.floor(remaining / 3_600_000);
	const minutes = Math.floor((remaining % 3_600_000) / 60_000);
	return `muted for ${hours > 0 ? `${hours}h ` : ''}${minutes}m more`;
}

async function handleHeartbeat(rest: string): Promise<string> {
	const sub = rest.trim().toLowerCase();
	const cfg = readChannelConfig();
	if (!cfg) return 'WhatsApp settings are invalid — fix settings.json first.';

	if (sub === '' || sub === 'status') {
		const lines = [
			`enabled: ${cfg.heartbeat.enabled}`,
			`every: ${cfg.heartbeat.every}`,
			`target: ${cfg.heartbeat.target ?? '<unset>'}`,
			`active hours: ${cfg.heartbeat.activeHours.start}–${cfg.heartbeat.activeHours.end} (${cfg.heartbeat.activeHours.timezone})`,
			`cap: ${fmtCount(cfg)}`,
			`mute: ${fmtMuteState(cfg)}`,
			`model: ${cfg.heartbeat.model}`,
		];
		const log = recentLog(3);
		if (log.length > 0) {
			lines.push('', 'recent:');
			for (const e of log) {
				const when = new Date(e.ts).toISOString().slice(11, 16);
				lines.push(`  ${when} · ${e.status}${e.taskName ? ` · ${e.taskName}` : ''}`);
			}
		}
		return lines.join('\n');
	}

	if (sub === 'now') {
		const result = await triggerHeartbeat();
		return `heartbeat triggered → ${result.status}${result.text ? `\n\n${result.text}` : ''}`;
	}

	return `Unknown subcommand "${sub}". Try /heartbeat status or /heartbeat now.`;
}

async function handleMute(rest: string): Promise<string> {
	const arg = rest.trim();
	const ms = parseDurationMs(arg || '24h') ?? 24 * 3_600_000;
	const until = new Date(Date.now() + ms).toISOString();
	await mutateHeartbeat({ muteUntil: until });
	const hours = Math.round(ms / 3_600_000);
	return `Heartbeat muted for ~${hours}h (until ${until.slice(0, 16)}Z). Reply /resume to lift.`;
}

async function handleResume(): Promise<string> {
	await mutateHeartbeat({ muteUntil: null });
	return 'Heartbeat resumed.';
}

/** Resolve and execute a heartbeat meta-command. Returns the reply text
 *  (may be multi-line). Caller is responsible for `sendText`. */
export async function handleHeartbeatMetaCommand(body: string): Promise<string> {
	const trimmed = body.trim();
	const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
	const rest = trimmed.slice(first?.length ?? 0).trim();

	if (first === '/heartbeat') return handleHeartbeat(rest);
	if (first === '/mute') return handleMute(rest);
	if (first === '/resume') return handleResume();
	return `Unknown command "${first}".`;
}
