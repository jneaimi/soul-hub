/**
 * Zod schemas for Soul Hub settings (`~/.soul-hub/settings.json`).
 *
 * The Zod schema is the source of truth — `SoulHubConfig` type is derived via
 * `z.infer<typeof ConfigSchema>`. Settings are validated on load and on POST.
 *
 * Defaults here MUST match the live behaviour of Soul Hub:
 *   - server.port: 2400 (PM2 prod)
 *   - proxy.blockedPorts: [2400] (block self-proxy)
 *   - orchestration.depInstaller: 'auto' | 'npm' | 'pnpm'
 *   - paths.* defaults match installer expectations (~/dev, ~/vault, …)
 */

import { z } from 'zod';
import { RoutesSchema } from './routes/route.schema.js';

export const TerminalSchema = z.object({
	fontSize: z.number().int().min(8).max(24).default(13),
	cols: z.number().int().min(40).max(400).default(120),
	rows: z.number().int().min(10).max(120).default(40),
	cursorBlink: z.boolean().default(true),
});

export const InterfaceSchema = z.object({
	defaultPanel: z.enum(['code', 'closed']).default('code'),
	panelWidth: z.number().int().min(180).max(800).default(260),
});

export const PathsSchema = z.object({
	devDir: z.string().default('~/dev'),
	vaultDir: z.string().default('~/vault'),
	catalogDir: z.string().default('~/dev/soul-hub/catalog'),
	claudeBinary: z.string().default('~/.local/bin/claude'),
});

export const ServerSchema = z.object({
	port: z.number().int().min(1).max(65535).default(2400),
});

export const ChannelActionSchema = z.enum(['send', 'prompt', 'listen']);

export const ChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	label: z.string().default(''),
	defaultFor: z.array(ChannelActionSchema).default([]),
});

/** WhatsApp-specific config — extends the generic ChannelConfig with the
 *  fields the Baileys adapter needs (auth dir, access policy, intent map). */
const E164 = z.string().regex(/^\+\d{6,15}$/, 'Expected E.164 phone number, e.g. "+9715xxxxxxxx"');

export const WhatsAppAccessSchema = z
	.object({
		dmPolicy: z.enum(['allowlist', 'open', 'disabled']).default('allowlist'),
		allowFrom: z.array(z.union([E164, z.literal('*')])).default([]),
		groupPolicy: z.enum(['allowlist', 'open', 'disabled']).default('allowlist'),
		groupAllowFrom: z.array(E164).default([]),
		groups: z
			.record(
				z.string(),
				z.object({ requireMention: z.boolean().default(true) }),
			)
			.default({}),
		mentionPatterns: z.array(z.string()).default([]),
	})
	.refine((d) => d.dmPolicy !== 'open' || d.allowFrom.includes('*'), {
		message: '`dmPolicy: "open"` requires `allowFrom` to include "*".',
	});

export const WhatsAppIntentMapSchema = z.record(
	z.string(),
	z.object({
		route: z.string(),
		description: z.string().optional(),
	}),
);

export const WhatsAppDeliverySchema = z.object({
	textChunkLimit: z.number().int().min(500).max(60_000).default(4000),
	chunkMode: z.enum(['newline', 'hard']).default('newline'),
	sendReadReceipts: z.boolean().default(true),
	ackEmoji: z.string().default('👀'),
	/** Print the QR pairing code to stdout as ASCII when one appears.
	 *  Useful when the Settings UI isn't reachable (headless first-run).
	 *  The PNG data URL is always exposed via /api/channels/whatsapp/status
	 *  regardless of this flag. */
	printTerminalQr: z.boolean().default(true),
	/** Drop inbound media that exceeds this size — protects the disk and
	 *  the transcription budget from runaway uploads. WhatsApp's own cap
	 *  is ~16MB for audio/voice, ~100MB for video. */
	maxMediaSizeMB: z.number().int().min(1).max(200).default(16),
	/** Auto-transcribe inbound voice notes and feed the transcript to the
	 *  routes layer as if it were typed text. Disable to keep voice notes
	 *  ignored or to handle them with a manual command. */
	transcribeVoiceNotes: z.boolean().default(true),
	/** Provider:model used for voice transcription. Must currently be a
	 *  Gemini reference — Gemini is the only multimodal provider wired
	 *  in this channel today. */
	transcribeProvider: z
		.string()
		.regex(/^gemini:.+$/)
		.default('gemini:gemini-2.5-flash'),
});

export const WhatsAppAccountSchema = z.object({
	authDir: z.string().default('~/.soul-hub/data/whatsapp/personal'),
});

/** Crash-isolation runtime: when `enabled`, Baileys lives in a separate
 *  PM2 app (`soul-hub-whatsapp`) and the main SvelteKit server proxies
 *  control + outbound calls to it via HTTP. Inbound messages flow back
 *  via a callback to `${mainAppUrl}/api/channels/whatsapp/_inbound`. */
export const WhatsAppWorkerSchema = z.object({
	enabled: z.boolean().default(false),
	url: z.string().url().default('http://127.0.0.1:2401'),
	mainAppUrl: z.string().url().default('http://127.0.0.1:2400'),
	/** Optional shared secret. When set, the main app and the worker
	 *  reject calls without a matching `Authorization: Bearer <token>`
	 *  header. Recommended for any host that exposes 2401 beyond
	 *  loopback; ignored on default loopback-only setups. */
	bearerToken: z.string().optional(),
});

/** Proactive heartbeat — periodic main-session turn that reads soul.md +
 *  HEARTBEAT.md and decides whether to nudge the user. The OpenClaw
 *  pattern: schedules + per-task content live in HEARTBEAT.md (vault),
 *  this block holds only operational knobs. The HEARTBEAT_OK contract
 *  lets the LLM judge "is anything worth surfacing?" — no condition
 *  language. See `~/vault/projects/soul-hub-brain/adr-001-architecture.md`. */
export const WhatsAppHeartbeatSchema = z.object({
	enabled: z.boolean().default(false),
	/** Base cadence. Cron expression OR duration string ("30m", "1h"). */
	every: z.string().default('30m'),
	/** Recipient. Heartbeats only deliver when this is set. */
	target: E164.optional(),
	/** Vault-relative path to the personality file (system prompt body). */
	soulPath: z.string().default('operations/soul.md'),
	/** Vault-relative path to the checklist + tasks file (user prompt body). */
	checklistPath: z.string().default('operations/whatsapp/HEARTBEAT.md'),
	activeHours: z
		.object({
			start: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
			end: z.string().regex(/^\d{2}:\d{2}$/).default('23:00'),
			timezone: z.string().default('Asia/Dubai'),
		})
		.prefault({}),
	maxPerDay: z.number().int().min(1).max(20).default(3),
	muteUntil: z.string().datetime().nullable().default(null),
	/** Max chars of non-token content allowed after HEARTBEAT_OK before
	 *  delivery is suppressed. Token in middle of message → not stripped. */
	ackMaxChars: z.number().int().min(50).max(2000).default(300),
	/** When true, heartbeat runs see no chat history. Recommended. */
	isolatedSession: z.boolean().default(true),
	/** Provider:model ref. Default Gemini Flash for cost; swap to
	 *  `claude-cli:claude-sonnet-4-6` if HEARTBEAT_OK ack rate stays low. */
	model: z
		.string()
		.regex(/^(gemini|claude-cli|openrouter|anthropic):.+$/, 'Expected "<provider>:<model>"')
		.default('gemini:gemini-2.5-flash'),
	basePrompt: z
		.string()
		.default(
			'Read HEARTBEAT.md (workspace context). Follow it strictly. ' +
				'If a task block is included below, run it. Do not infer or repeat old tasks. ' +
				'If nothing genuinely needs attention, reply HEARTBEAT_OK.',
		),
});

export const WhatsAppChannelSchema = ChannelConfigSchema.extend({
	account: z.string().default('personal'),
	accounts: z
		.record(z.string(), WhatsAppAccountSchema)
		.default({ personal: { authDir: '~/.soul-hub/data/whatsapp/personal' } }),
	access: WhatsAppAccessSchema.prefault({}),
	delivery: WhatsAppDeliverySchema.prefault({}),
	worker: WhatsAppWorkerSchema.prefault({}),
	heartbeat: WhatsAppHeartbeatSchema.prefault({}),
	intentMap: WhatsAppIntentMapSchema.default({
		'/translate': { route: 'translate-arabic' },
		default: { route: 'vault-chat' },
	}),
});

export const OrchestrationSchema = z.object({
	maxWorkers: z.number().int().min(1).max(16).default(4),
	maxIterationsPerWorker: z.number().int().min(1).default(8),
	worktreeDir: z.string().default('.worktrees'),
	depInstaller: z.enum(['pnpm', 'npm', 'auto']).default('auto'),
});

export const ProxySchema = z.object({
	enabled: z.boolean().default(true),
	allowedPortRange: z.tuple([z.number().int(), z.number().int()]).default([1024, 9999]),
	blockedPorts: z.array(z.number().int()).default([2400]),
});

export const ConfigSchema = z.object({
	terminal: TerminalSchema.prefault({}),
	interface: InterfaceSchema.prefault({}),
	paths: PathsSchema.prefault({}),
	server: ServerSchema.prefault({}),
	// Channels store base fields strictly + allow per-channel extensions to
	// flow through; each adapter Zod-validates its own slice on read (e.g.
	// WhatsAppChannelSchema for the `whatsapp` entry).
	channels: z.record(z.string(), ChannelConfigSchema.passthrough()).prefault({
		telegram: { enabled: false, label: 'Telegram', defaultFor: ['send'] },
		whatsapp: {
			enabled: false,
			label: 'WhatsApp',
			defaultFor: [],
			account: 'personal',
			accounts: { personal: { authDir: '~/.soul-hub/data/whatsapp/personal' } },
			access: {
				dmPolicy: 'allowlist',
				allowFrom: [],
				groupPolicy: 'allowlist',
				groupAllowFrom: [],
				groups: {},
				mentionPatterns: [],
			},
			delivery: {
				textChunkLimit: 4000,
				chunkMode: 'newline',
				sendReadReceipts: true,
				ackEmoji: '👀',
				printTerminalQr: true,
				maxMediaSizeMB: 16,
				transcribeVoiceNotes: true,
				transcribeProvider: 'gemini:gemini-2.5-flash',
			},
			worker: {
				enabled: false,
				url: 'http://127.0.0.1:2401',
				mainAppUrl: 'http://127.0.0.1:2400',
			},
			heartbeat: {
				enabled: false,
				every: '30m',
				soulPath: 'operations/soul.md',
				checklistPath: 'operations/whatsapp/HEARTBEAT.md',
				activeHours: { start: '08:00', end: '23:00', timezone: 'Asia/Dubai' },
				maxPerDay: 3,
				muteUntil: null,
				ackMaxChars: 300,
				isolatedSession: true,
				model: 'gemini:gemini-2.5-flash',
			},
			intentMap: {
				'/translate': { route: 'translate-arabic' },
				default: { route: 'vault-chat' },
			},
		},
	}),
	orchestration: OrchestrationSchema.prefault({}),
	proxy: ProxySchema.prefault({}),
	routes: RoutesSchema.prefault({
		'vault-chat': {
			description: 'Free-form chat against the vault — primary intent for WhatsApp DMs.',
			default: 'openrouter:google/gemini-2.5-flash',
			failover: ['gemini:gemini-2.5-flash'],
			timeoutMs: 8000,
			retries: 1,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
		'translate-arabic': {
			description: 'Bilingual translation route — Gemini direct preferred for cost.',
			default: 'gemini:gemini-2.5-flash',
			failover: ['openrouter:google/gemini-2.5-flash'],
			timeoutMs: 8000,
			retries: 1,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
	}),
});

export type SoulHubConfig = z.infer<typeof ConfigSchema>;
