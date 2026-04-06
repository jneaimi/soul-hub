import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || '';

interface HealthStatus {
	server: {
		nodeRunning: boolean;
		tunnelRunning: boolean;
		port: number;
		domain: string;
	};
	knowledgeDb: {
		exists: boolean;
		noteCount: number | null;
		dbSizeBytes: number | null;
		lastModified: string | null;
	};
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isProcessRunning(pidFile: string): Promise<boolean> {
	try {
		const pidStr = await readFile(pidFile, 'utf-8');
		const pid = parseInt(pidStr.trim(), 10);
		if (isNaN(pid)) return false;
		process.kill(pid, 0); // signal 0 = check if alive
		return true;
	} catch {
		return false;
	}
}

async function getKnowledgeDbStats(): Promise<HealthStatus['knowledgeDb']> {
	const dbPath = resolve(HOME, 'dev', 'knowledge-db', 'knowledge.db');
	const exists = await fileExists(dbPath);
	if (!exists) return { exists: false, noteCount: null, dbSizeBytes: null, lastModified: null };

	try {
		const s = await stat(dbPath);
		let noteCount: number | null = null;

		try {
			const { stdout } = await execFileAsync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM notes;'], { timeout: 5000 });
			noteCount = parseInt(stdout.trim(), 10) || null;
		} catch { /* sqlite3 not available or table doesn't exist */ }

		return {
			exists: true,
			noteCount,
			dbSizeBytes: s.size,
			lastModified: s.mtime.toISOString(),
		};
	} catch {
		return { exists: true, noteCount: null, dbSizeBytes: null, lastModified: null };
	}
}

/** GET /api/system-health — server + knowledge DB status */
export const GET: RequestHandler = async () => {
	const pidsDir = resolve(HOME, 'dev', 'soul-hub', '.pids');

	const [nodeRunning, tunnelRunning, knowledgeDb] = await Promise.all([
		isProcessRunning(resolve(pidsDir, 'node.pid')),
		isProcessRunning(resolve(pidsDir, 'cloudflared.pid')),
		getKnowledgeDbStats(),
	]);

	const health: HealthStatus = {
		server: {
			nodeRunning,
			tunnelRunning,
			port: 5173,
			domain: 'soul-hub.jneaimi.com',
		},
		knowledgeDb,
	};

	return json(health);
};
