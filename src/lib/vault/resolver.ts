export class WikilinkResolver {
	private filenameMap = new Map<string, string[]>();

	build(paths: string[]): void {
		this.filenameMap.clear();
		for (const p of paths) {
			this.addToMap(p);
		}
	}

	resolve(raw: string, sourcePath?: string): string | null {
		const normalized = raw.trim().replace(/\.md$/i, '').toLowerCase();
		if (!normalized) return null;

		if (normalized.includes('/')) {
			for (const [, paths] of this.filenameMap) {
				for (const p of paths) {
					if (p.toLowerCase() === normalized + '.md' || p.toLowerCase() === normalized) {
						return p;
					}
				}
			}
			return null;
		}

		const matches = this.filenameMap.get(normalized);
		if (!matches || matches.length === 0) return null;
		if (matches.length === 1) return matches[0];

		// Ambiguous bare stem — pick the closest match relative to the source.
		// "Closest" = longest shared directory prefix; ties broken by shallower path.
		if (!sourcePath) return null;
		const sourceDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
		const sourceParts = sourceDir.split('/').filter(Boolean);
		let best: { path: string; shared: number; depth: number } | null = null;
		for (const candidate of matches) {
			const candDir = candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '';
			const candParts = candDir.split('/').filter(Boolean);
			let shared = 0;
			while (shared < sourceParts.length && shared < candParts.length && sourceParts[shared] === candParts[shared]) {
				shared++;
			}
			const depth = candParts.length;
			if (!best || shared > best.shared || (shared === best.shared && depth < best.depth)) {
				best = { path: candidate, shared, depth };
			}
		}
		return best ? best.path : null;
	}

	add(path: string): void {
		this.addToMap(path);
	}

	remove(path: string): void {
		const key = this.filenameKey(path);
		const existing = this.filenameMap.get(key);
		if (!existing) return;
		const filtered = existing.filter((p) => p !== path);
		if (filtered.length === 0) {
			this.filenameMap.delete(key);
		} else {
			this.filenameMap.set(key, filtered);
		}
	}

	private addToMap(path: string): void {
		const key = this.filenameKey(path);
		const existing = this.filenameMap.get(key) ?? [];
		if (!existing.includes(path)) {
			existing.push(path);
		}
		this.filenameMap.set(key, existing);
	}

	private filenameKey(path: string): string {
		const basename = path.split('/').pop() ?? path;
		return basename.replace(/\.md$/i, '').toLowerCase();
	}
}
