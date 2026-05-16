import { readdir, stat, rename, copyFile, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

export interface WatchConfig {
	/** Which input name to use as the folder path */
	input: string;
	/** Glob pattern for matching files (default: '*') */
	pattern?: string;
	/** Poll interval in seconds (min: 10, default: 60) */
	poll_interval?: number;
	/** Subdirectory for processed files (default: 'processed') */
	processed_dir?: string;
	/** Subdirectory for failed files (default: 'failed') */
	failed_dir?: string;
	/** Max concurrent file processing (default: 1, max: 5) */
	max_concurrent?: number;
	/** Seconds file mtime must be stable before processing (default: 5) */
	stable_seconds?: number;
	/** Enabled flag */
	enabled?: boolean;
}

export interface WatchStatus {
	/** Currently processing files */
	inProgress: Set<string>;
	/** Last 10 processed files with results */
	history: { filename: string; status: 'processed' | 'failed' | 'move-failed'; timestamp: string; error?: string }[];
}

export async function scanFolder(
	folderPath: string,
	pattern: string = '*',
	stableSeconds: number = 5,
): Promise<string[]> {
	try {
		await access(folderPath, constants.R_OK);
	} catch {
		return [];
	}

	const entries = await readdir(folderPath, { withFileTypes: true });
	const skipDirs = new Set(['processed', 'failed', '.processing']);

	const candidates: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name.startsWith('.')) continue;
		if (skipDirs.has(entry.name)) continue;

		if (pattern !== '*') {
			const ext = pattern.startsWith('*.') ? pattern.slice(1) : null;
			if (ext && !entry.name.endsWith(ext)) continue;
		}

		candidates.push(entry.name);
	}

	const now = Date.now();
	const stable: string[] = [];
	for (const filename of candidates) {
		try {
			const fileStat = await stat(join(folderPath, filename));
			const ageMs = now - fileStat.mtimeMs;
			if (ageMs >= stableSeconds * 1000) {
				stable.push(filename);
			}
		} catch {
			// File may have been deleted between readdir and stat — skip
		}
	}

	return stable.sort();
}

export async function moveFile(
	srcPath: string,
	destDir: string,
	filename: string,
): Promise<string> {
	await mkdir(destDir, { recursive: true });

	const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const destFilename = `${ts}_${filename}`;
	const destPath = join(destDir, destFilename);

	try {
		await rename(srcPath, destPath);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
			await copyFile(srcPath, destPath);
			await unlink(srcPath);
		} else {
			throw err;
		}
	}

	return destPath;
}

export async function ensureWatchDirs(
	folderPath: string,
	processedDir: string = 'processed',
	failedDir: string = 'failed',
): Promise<void> {
	await mkdir(join(folderPath, processedDir), { recursive: true });
	await mkdir(join(folderPath, failedDir), { recursive: true });
}
