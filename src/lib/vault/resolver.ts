export class WikilinkResolver {
	private filenameMap = new Map<string, string[]>();

	build(paths: string[]): void {
		this.filenameMap.clear();
		for (const p of paths) {
			this.addToMap(p);
		}
	}

	resolve(raw: string): string | null {
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
		return null; // ambiguous
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
