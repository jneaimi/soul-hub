import { readdir, readFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import type { VaultZone } from './types.js';
import { IGNORED_FOLDERS } from './types.js';

export class GovernanceResolver {
	private zones = new Map<string, VaultZone>();

	async scan(vaultRoot: string): Promise<void> {
		this.zones.clear();
		const claudeFiles = await findClaudeMdFiles(vaultRoot, vaultRoot);
		for (const absPath of claudeFiles) {
			const raw = await readFile(absPath, 'utf-8');
			const zonePath = relative(vaultRoot, dirname(absPath));
			const zone = parseGovernance(zonePath, raw);
			this.zones.set(zonePath, zone);
		}
	}

	resolve(targetPath: string): VaultZone {
		const parts = targetPath.split('/');
		// Walk from most specific to least specific (include full path)
		for (let i = parts.length; i >= 0; i--) {
			const candidate = parts.slice(0, i).join('/');
			const zone = this.zones.get(candidate);
			if (zone) return zone;
		}

		return {
			path: '',
			allowedTypes: [],
			requireTemplate: false,
			requiredFields: [],
			rawGovernance: ''
		};
	}

	getZones(): VaultZone[] {
		return Array.from(this.zones.values());
	}
}

async function findClaudeMdFiles(dir: string, vaultRoot: string): Promise<string[]> {
	const results: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (IGNORED_FOLDERS.includes(entry.name)) continue;

		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await findClaudeMdFiles(fullPath, vaultRoot)));
		} else if (entry.name === 'CLAUDE.md') {
			results.push(fullPath);
		}
	}

	return results;
}

function parseGovernance(zonePath: string, raw: string): VaultZone {
	const allowedTypes = extractListSection(raw, 'Allowed Types');
	const requiredFields = extractListSection(raw, 'Required Fields');
	const namingPattern = extractNamingPattern(raw);
	const requireTemplate =
		/template\s+.*(?:required|MUST\s+use)/i.test(raw) ||
		/(?:required|MUST\s+use)\s+.*template/i.test(raw);

	return {
		path: zonePath,
		allowedTypes,
		requireTemplate,
		requiredFields,
		namingPattern: namingPattern ?? undefined,
		rawGovernance: raw
	};
}

function extractListSection(raw: string, heading: string): string[] {
	const pattern = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
	const match = pattern.exec(raw);
	if (!match) return [];

	const afterHeading = raw.slice(match.index + match[0].length);
	const nextSection = afterHeading.search(/^##\s+/m);
	const block = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
	const trimmed = block.trim();

	if (!trimmed) return [];

	// Handle bullet lists: - item or * item
	const bullets = trimmed.match(/^[-*]\s+(.+)$/gm);
	if (bullets) {
		return bullets.map((b) => b.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
	}

	// Handle comma-separated on a single line
	return trimmed
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function extractNamingPattern(raw: string): string | null {
	const pattern = /^##\s+Naming\s*$/im;
	const match = pattern.exec(raw);
	if (!match) return null;

	const afterHeading = raw.slice(match.index + match[0].length);
	const nextSection = afterHeading.search(/^##\s+/m);
	const block = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
	const trimmed = block.trim();

	// Only extract patterns that look like real regex (start with ^ or contain character classes)
	const backtick = /`([^`]+)`/.exec(trimmed);
	const candidate = backtick?.[1] ?? trimmed.split('\n')[0]?.trim();
	if (!candidate) return null;

	// Only accept actual regex patterns (must start with ^ for anchoring)
	if (candidate.startsWith('^')) {
		return candidate;
	}

	return null;
}
