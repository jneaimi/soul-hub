import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { config } from '$lib/config.js';

const CATALOG_DIR = config.resolved.catalogDir;
const REGISTRY_PATH = resolve(CATALOG_DIR, 'registry.json');

export const POST: RequestHandler = async ({ request }) => {
	const { type, name, projectPath } = await request.json();

	if (!type || !name || !projectPath) {
		return json({ error: 'Missing type, name, or projectPath' }, { status: 400 });
	}

	// Validate project path is under ~/dev/
	const resolved = resolve(projectPath);
	if (!resolved.startsWith(config.resolved.devDir + '/')) {
		return json({ error: 'Invalid project path' }, { status: 403 });
	}

	try {
		if (type === 'skill') {
			const src = resolve(CATALOG_DIR, 'skills', name);
			const dest = resolve(resolved, '.claude', 'skills', name);
			await mkdir(resolve(resolved, '.claude', 'skills'), { recursive: true });
			await cp(src, dest, { recursive: true });
			return json({ ok: true, installed: dest });
		}

		if (type === 'agent') {
			const src = resolve(CATALOG_DIR, 'agents', `${name}.md`);
			const dest = resolve(resolved, '.claude', 'agents', `${name}.md`);
			await mkdir(resolve(resolved, '.claude', 'agents'), { recursive: true });
			await cp(src, dest);
			return json({ ok: true, installed: dest });
		}

		if (type === 'mcp') {
			// Read MCP server config from registry
			const registryRaw = await readFile(REGISTRY_PATH, 'utf-8');
			const registry = JSON.parse(registryRaw);
			const mcpEntry = (registry.mcpServers || []).find((m: any) => m.name === name);
			if (!mcpEntry) {
				return json({ error: `MCP server "${name}" not found in catalog` }, { status: 404 });
			}

			// Build the server config
			const serverConfig: Record<string, any> = {};
			if (mcpEntry.command) serverConfig.command = mcpEntry.command;
			if (mcpEntry.args) serverConfig.args = mcpEntry.args;
			if (mcpEntry.url) serverConfig.url = mcpEntry.url;
			if (mcpEntry.url) serverConfig.type = 'http';
			// Env vars: add placeholder keys (user fills in values via Platform Environment)
			if (mcpEntry.env_vars?.length) {
				serverConfig.env = {};
				for (const env of mcpEntry.env_vars) {
					// Use process.env value if available, otherwise empty placeholder
					serverConfig.env[env.name] = process.env[env.name] || '';
				}
			}

			// Read or create .mcp.json
			const mcpJsonPath = resolve(resolved, '.mcp.json');
			let mcpJson: { mcpServers: Record<string, any> } = { mcpServers: {} };
			try {
				const existing = await readFile(mcpJsonPath, 'utf-8');
				mcpJson = JSON.parse(existing);
				if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
			} catch {
				// File doesn't exist — start fresh
			}

			// Add/overwrite the server
			mcpJson.mcpServers[name] = serverConfig;

			await writeFile(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');
			return json({ ok: true, installed: mcpJsonPath });
		}

		return json({ error: 'Invalid type — must be skill, agent, or mcp' }, { status: 400 });
	} catch (err) {
		return json({ error: `Install failed: ${(err as Error).message}` }, { status: 500 });
	}
};
