/**
 * Append-only audit log for file-explorer access.
 *
 * Every `raw` and `read` action against /api/files writes one JSONL line
 * to .data/file-access.log. `list` is intentionally excluded — it's noisy
 * and a directory listing isn't a sensitive event by itself.
 *
 * No rotation in Phase 1; revisit when the file gets large in practice.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const LOG_PATH = resolve(process.cwd(), '.data', 'file-access.log');

export interface AuditEvent {
	ts: string;
	ip: string;
	action: 'raw' | 'read';
	path: string;
	bytes?: number;
	status: 'ok' | 'denied' | 'too_large' | 'not_found';
}

let dirEnsured = false;
async function ensureLogDir(): Promise<void> {
	if (dirEnsured) return;
	const dir = dirname(LOG_PATH);
	if (!existsSync(dir)) await mkdir(dir, { recursive: true });
	dirEnsured = true;
}

export async function recordAccess(event: AuditEvent): Promise<void> {
	try {
		await ensureLogDir();
		await appendFile(LOG_PATH, JSON.stringify(event) + '\n', 'utf-8');
	} catch {
		// Audit logging is best-effort — never fail the request because the log write failed
	}
}

export { LOG_PATH };
