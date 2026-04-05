import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { mkdir, writeFile, cp, stat, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTemplate } from '$lib/templates/index.js';

const execFileAsync = promisify(execFile);

const HOME = process.env.HOME || '';
const DEV_DIR = resolve(HOME, 'dev');
const BRAIN_DIR = resolve(HOME, 'SecondBrain');
const MARKETPLACE_DIR = resolve(HOME, 'dev', 'soul-hub', 'marketplace');

/** Sanitize project name: lowercase, alphanumeric + hyphens only */
function sanitizeName(raw: string): string | null {
	const name = raw
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	if (!name || name.length < 2 || name.length > 64) return null;
	// Block path traversal
	if (name.includes('..') || name.startsWith('/')) return null;
	return name;
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

async function writeNestedFile(basePath: string, relativePath: string, content: string) {
	const fullPath = join(basePath, relativePath);
	const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
	await mkdir(dir, { recursive: true });
	await writeFile(fullPath, content, 'utf-8');
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { templateId, name: rawName, variant, skills, agents } = body as {
		templateId: string;
		name: string;
		variant?: string;
		skills: string[];
		agents: string[];
	};

	// Validate template
	const template = getTemplate(templateId);
	if (!template) {
		return json({ error: 'Invalid template' }, { status: 400 });
	}

	// Sanitize name
	const name = sanitizeName(rawName);
	if (!name) {
		return json(
			{ error: 'Invalid project name. Use 2-64 characters: lowercase letters, numbers, hyphens.' },
			{ status: 400 }
		);
	}

	// Check for existing project
	const devPath = join(DEV_DIR, name);
	const brainPath = join(BRAIN_DIR, template.brainArea, name);

	if (await dirExists(devPath)) {
		return json({ error: `Project already exists at ~/dev/${name}/` }, { status: 409 });
	}
	if (await dirExists(brainPath)) {
		return json(
			{ error: `Brain folder already exists at ~/SecondBrain/${template.brainArea}/${name}/` },
			{ status: 409 }
		);
	}

	// Track created paths for cleanup on error
	const created: string[] = [];

	try {
		// 1. Create ~/dev/<name>/ with template files
		await mkdir(devPath, { recursive: true });
		created.push(devPath);

		const devFiles = template.devFiles(name, variant);
		for (const [filePath, content] of Object.entries(devFiles)) {
			await writeNestedFile(devPath, filePath, content);
		}

		// 2. Create ~/SecondBrain/<area>/<name>/ with brain files
		await mkdir(brainPath, { recursive: true });
		created.push(brainPath);

		const brainFiles = template.brainFiles(name);
		for (const [filePath, content] of Object.entries(brainFiles)) {
			await writeNestedFile(brainPath, filePath, content);
		}

		// Create brain subfolders
		for (const folder of template.brainFolders) {
			await mkdir(join(brainPath, folder), { recursive: true });
		}

		// 3. Copy selected skills from marketplace
		for (const skillName of skills) {
			const src = join(MARKETPLACE_DIR, 'skills', skillName);
			const dst = join(devPath, '.claude', 'skills', skillName);
			if (await dirExists(src)) {
				await cp(src, dst, { recursive: true });
			}
		}

		// 4. Copy selected agents from marketplace
		for (const agentName of agents) {
			const src = join(MARKETPLACE_DIR, 'agents', `${agentName}.md`);
			const dst = join(devPath, '.claude', 'agents', `${agentName}.md`);
			try {
				await cp(src, dst);
			} catch {
				// Agent file doesn't exist in marketplace — skip
			}
		}

		// 5. git init
		try {
			await execFileAsync('git', ['init'], { cwd: devPath });
		} catch {
			// git not available or failed — non-fatal
		}

		return json({
			success: true,
			name,
			devPath,
			brainPath,
		});
	} catch (err) {
		// Cleanup on error — remove partially created directories
		for (const path of created) {
			try {
				await rm(path, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup
			}
		}
		return json(
			{ error: `Failed to create project: ${err instanceof Error ? err.message : 'Unknown error'}` },
			{ status: 500 }
		);
	}
};
