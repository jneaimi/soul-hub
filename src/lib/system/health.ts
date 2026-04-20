/**
 * SystemHealth — the immune system for Soul Hub.
 *
 * Runs on startup + every 6 hours:
 *   detect() → classify() → auto-fix safe issues → notify for human-required ones
 *
 * This is a SYSTEM service, not a user pipeline. It initializes alongside
 * the vault engine and pipeline scheduler in hooks.server.ts.
 */

import { resolve } from 'node:path';
import { getVaultEngine } from '../vault/index.js';
import { sendViaChannel } from '../channels/registry.js';
import { config } from '../config.js';
import { NotificationStore } from './notifications.js';
import { healOrphans, healMissingRootIndex, healMissingFrontmatter } from './healers/vault-healer.js';
import type { DetectedIssue, HealthReport, HealResult } from './types.js';

const HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let instance: SystemHealth | null = null;

export class SystemHealth {
	readonly notifications: NotificationStore;
	private healthInterval: ReturnType<typeof setInterval> | null = null;
	private vaultRoot: string;
	private lastReport: HealthReport | null = null;
	private running = false;

	constructor(dataDir: string, vaultRoot: string) {
		this.notifications = new NotificationStore(dataDir);
		this.vaultRoot = vaultRoot;
	}

	async init(): Promise<void> {
		await this.notifications.load();

		// Run health check on startup (delayed 10s to let vault finish indexing)
		setTimeout(() => this.runHealthCheck(), 10_000);

		// Then every 6 hours
		this.healthInterval = setInterval(() => this.runHealthCheck(), HEALTH_INTERVAL_MS);

		console.log(`[system-health] Initialized (${this.notifications.activeCount} active notifications)`);
	}

	shutdown(): void {
		if (this.healthInterval) clearInterval(this.healthInterval);
	}

	/** Get the last health report */
	getLastReport(): HealthReport | null {
		return this.lastReport;
	}

	/** Force a health check now (called by API) */
	async forceCheck(): Promise<HealthReport> {
		return this.runHealthCheck();
	}

	/** Run the full detect → classify → heal → notify cycle */
	private async runHealthCheck(): Promise<HealthReport> {
		if (this.running) {
			console.log('[system-health] Skipping — check already in progress');
			return this.lastReport ?? this.emptyReport();
		}

		this.running = true;
		const start = Date.now();

		try {
			const vault = getVaultEngine();
			if (!vault) {
				console.log('[system-health] Vault not ready — skipping health check');
				return this.emptyReport();
			}

			// ── Phase 1: Detect ──
			const issues = await this.detect(vault);

			// ── Phase 2: Auto-fix safe issues ──
			const autoFixed: HealResult[] = [];
			for (const issue of issues.filter((i) => i.risk === 'safe')) {
				const result = await this.heal(issue);
				if (result) autoFixed.push(result);
			}

			// ── Phase 3: Create notifications for human-required issues ──
			let notificationsCreated = 0;
			for (const issue of issues.filter((i) => i.risk !== 'safe')) {
				this.notifications.add({
					source: 'vault',
					severity: issue.risk === 'needs_claude' ? 'action_required' : 'warning',
					title: issue.title,
					detail: issue.detail,
					actions: issue.actions,
				});
				notificationsCreated++;
			}

			// Auto-resolve vault notifications whose issues no longer exist
			const currentIssueTitles = new Set(issues.filter((i) => i.risk !== 'safe').map((i) => i.title));
			for (const n of this.notifications.getActive()) {
				if (n.source === 'vault' && !currentIssueTitles.has(n.title)) {
					this.notifications.resolve(n.id, 'auto', 'Issue no longer detected');
				}
			}

			// Prune old resolved notifications
			this.notifications.prune(7);
			await this.notifications.save();

			// Reindex vault if we made changes
			if (autoFixed.some((r) => r.fixed.length > 0)) {
				await vault.reindex();
			}

			const report: HealthReport = {
				timestamp: new Date().toISOString(),
				totalNotes: vault.getStats().totalNotes,
				issues,
				autoFixed,
				notificationsCreated,
			};

			this.lastReport = report;

			const fixedCount = autoFixed.reduce((sum, r) => sum + r.fixed.length, 0);
			const elapsed = Date.now() - start;
			console.log(
				`[system-health] Check complete in ${elapsed}ms: ` +
				`${issues.length} issues found, ${fixedCount} auto-fixed, ${notificationsCreated} notifications`
			);

			// Send digest via built-in channel (Telegram) if anything happened
			if (notificationsCreated > 0 || fixedCount > 0) {
				await this.sendDigestViaChannel(report);
			}

			return report;
		} catch (err) {
			console.error('[system-health] Health check failed:', err);
			return this.emptyReport();
		} finally {
			this.running = false;
		}
	}

	/** Detect all vault issues and classify by risk */
	private async detect(vault: ReturnType<typeof getVaultEngine> & object): Promise<DetectedIssue[]> {
		const issues: DetectedIssue[] = [];
		const allNotes = (vault as any).getRecent?.(99999) ?? [];
		// Use the methods we know exist
		const orphans = vault.getOrphans();
		const unresolved = vault.getUnresolved();
		const stats = vault.getStats();

		const VALID_ZONES = new Set(['inbox', 'projects', 'knowledge', 'content', 'operations', 'archive']);
		const EXEMPT_ZONES = new Set(['inbox', 'archive']);

		// ── Orphan Notes ──
		if (orphans.length > 0) {
			// Group by zone for classification — only recognized vault zones
			const byZone = new Map<string, string[]>();
			for (const note of orphans) {
				const zone = note.path.split('/')[0];
				if (!VALID_ZONES.has(zone) || EXEMPT_ZONES.has(zone)) continue;
				if (!byZone.has(zone)) byZone.set(zone, []);
				byZone.get(zone)!.push(note.path);
			}

			for (const [zone, paths] of byZone) {
				// Check if zone has an index — if yes, safe to auto-link
				const hasIndex = allNotes.some((n: any) => n.path === `${zone}/index.md`);

				if (paths.length <= 50 && hasIndex) {
					issues.push({
						type: 'orphan_notes',
						risk: 'safe',
						title: `${paths.length} orphan notes in ${zone}/`,
						detail: `Notes with no wikilinks can be auto-linked to ${zone}/index.md`,
						paths,
						actions: [],
					});
				} else {
					issues.push({
						type: 'orphan_notes',
						risk: paths.length > 100 ? 'needs_claude' : 'needs_human',
						title: `${paths.length} orphan notes in ${zone}/`,
						detail: paths.length > 50
							? `Too many orphans to auto-fix (${paths.length}). Review and approve batch linking.`
							: `No index.md found in ${zone}/ — create one first or link manually.`,
						paths,
						actions: [
							{
								id: `fix-orphans-${zone}`,
								label: `Auto-link orphans in ${zone}/`,
								type: 'api',
								endpoint: '/api/system/actions',
								method: 'POST',
								body: { action: 'heal-orphans', zone },
							},
							{
								id: `claude-orphans-${zone}`,
								label: 'Launch Claude to investigate',
								type: 'claude',
								prompt: `Review the ${paths.length} orphan notes in ~/vault/${zone}/ and organize them. Link each to the appropriate index or move to the correct zone. Paths:\n${paths.slice(0, 20).join('\n')}${paths.length > 20 ? `\n... and ${paths.length - 20} more` : ''}`,
								cwd: '~/vault',
							},
						],
					});
				}
			}
		}

		// ── Dead Links ──
		if (unresolved.length > 0) {
			issues.push({
				type: 'dead_links',
				risk: 'needs_human',
				title: `${unresolved.length} broken wikilinks`,
				detail: unresolved.slice(0, 10).map((u) => `${u.source} → [[${u.raw}]]`).join('\n'),
				paths: unresolved.map((u) => u.source),
				actions: [
					{
						id: 'auto-fix-dead-links',
						label: 'Auto-fix links',
						type: 'api',
						endpoint: '/api/system/actions',
						method: 'POST',
						body: { action: 'heal-broken-links' },
					},
					{
						id: 'fix-dead-links-claude',
						label: 'Fix with Claude (headless)',
						type: 'api',
						endpoint: '/api/system/actions',
						method: 'POST',
						body: {
							action: 'run-claude-headless',
							cwd: '~/vault',
							model: 'claude-haiku-4-5',
							timeoutMs: 120_000,
							allowedTools: ['Edit', 'Read', 'Glob', 'Grep'],
							prompt: `Fix these broken wikilinks in ~/vault/:\n${unresolved.slice(0, 20).map((u) => `- ${u.source}: [[${u.raw}]]`).join('\n')}\n\nFor each, find the correct target file and rewrite the wikilink, or remove the link if no match exists. Make the edits directly — do not ask for confirmation.`,
						},
					},
				],
			});
		}

		// ── Missing Root Index ──
		const rootIndexExists = allNotes.some((n: any) => n.path === 'index.md');
		if (!rootIndexExists) {
			issues.push({
				type: 'missing_index',
				risk: 'safe',
				title: 'Root index.md missing',
				detail: 'Vault has no root entry point. Will auto-generate from zone list.',
				paths: [],
				actions: [],
			});
		}

		// ── Missing Frontmatter ──
		const missingCreated = allNotes.filter((n: any) => !n.meta?.created);
		if (missingCreated.length > 0) {
			const paths = missingCreated.map((n: any) => n.path);
			issues.push({
				type: 'missing_frontmatter',
				risk: paths.length <= 50 ? 'safe' : 'needs_human',
				title: `${paths.length} notes missing 'created' field`,
				detail: 'Will backfill from file modification time.',
				paths,
				actions: paths.length > 50 ? [
					{
						id: 'fix-frontmatter',
						label: 'Backfill created dates',
						type: 'api',
						endpoint: '/api/system/actions',
						method: 'POST',
						body: { action: 'heal-frontmatter' },
					},
				] : [],
			});
		}

		return issues;
	}

	/** Execute auto-fix for a safe issue */
	private async heal(issue: DetectedIssue): Promise<HealResult | null> {
		const vault = getVaultEngine();
		if (!vault) return null;

		// Get all notes via stats-based approach
		const allNotes = vault.getRecent(99999);

		switch (issue.type) {
			case 'orphan_notes': {
				const orphanNotes = vault.getOrphans().filter((n) => issue.paths.includes(n.path));
				return healOrphans(this.vaultRoot, orphanNotes, allNotes);
			}
			case 'missing_index':
				return healMissingRootIndex(this.vaultRoot, allNotes);
			case 'missing_frontmatter':
				return healMissingFrontmatter(this.vaultRoot, allNotes);
			default:
				return null;
		}
	}

	/** Send health digest via built-in channel system (Telegram etc.) */
	private async sendDigestViaChannel(report: HealthReport): Promise<void> {
		const humanIssues = report.issues.filter((i) => i.risk !== 'safe');
		const totalFixed = report.autoFixed.reduce((s, r) => s + r.fixed.length, 0);

		if (humanIssues.length === 0 && totalFixed === 0) return;

		const lines: string[] = [];

		if (totalFixed > 0) {
			lines.push(`*[Soul Hub] Vault Health*`);
			lines.push('');
			const fixDetails = report.autoFixed
				.filter((r) => r.fixed.length > 0)
				.map((r) => `- ${r.type.replace(/_/g, ' ')}: ${r.fixed.length} fixed`);
			lines.push(...fixDetails);
		}

		if (humanIssues.length > 0) {
			if (lines.length > 0) lines.push('');
			lines.push(`*${humanIssues.length} issue${humanIssues.length === 1 ? '' : 's'} need attention:*`);
			lines.push(...humanIssues.map((i) => `- ${i.title}`));
			lines.push('', '_Open Soul Hub dashboard to review._');
		}

		try {
			const result = await sendViaChannel(undefined, config.channels, lines.join('\n'));
			if (!result.ok) {
				console.warn(`[system-health] Channel send failed: ${result.error}`);
			} else {
				console.log(`[system-health] Digest sent via channel (msgId: ${result.messageId})`);
			}
		} catch (err) {
			console.error('[system-health] Channel send error:', err);
		}
	}

	private emptyReport(): HealthReport {
		return {
			timestamp: new Date().toISOString(),
			totalNotes: 0,
			issues: [],
			autoFixed: [],
			notificationsCreated: 0,
		};
	}
}

// ── Module-level singleton ──

export function getSystemHealth(): SystemHealth | null {
	return instance;
}

export async function initSystemHealth(dataDir: string, vaultRoot: string): Promise<SystemHealth> {
	if (instance) return instance;
	const health = new SystemHealth(dataDir, vaultRoot);
	await health.init();
	instance = health;
	return instance;
}
