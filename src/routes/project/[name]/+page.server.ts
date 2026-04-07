import type { PageServerLoad } from './$types';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { config } from '$lib/config.js';

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const name = params.name;
	const devPath = resolve(config.resolved.devDir, name);
	const brainProject = resolve(config.resolved.brainProjects, name);
	const brainArea = resolve(config.resolved.brainAreas, name);

	const hasDev = await dirExists(devPath);
	const hasBrainProject = await dirExists(brainProject);
	const hasBrainArea = await dirExists(brainArea);

	return {
		name,
		devPath: hasDev ? devPath : null,
		brainPath: hasBrainProject ? brainProject : hasBrainArea ? brainArea : null,
		cwd: hasDev ? devPath : process.env.HOME ?? '/tmp',
	};
};
