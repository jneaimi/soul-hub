import type { PageServerLoad } from './$types';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

const HOME = process.env.HOME || '';

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
	const devPath = resolve(HOME, 'dev', name);
	const brainProject = resolve(HOME, 'SecondBrain', '01-projects', name);
	const brainArea = resolve(HOME, 'SecondBrain', '02-areas', name);

	const hasDev = await dirExists(devPath);
	const hasBrainProject = await dirExists(brainProject);
	const hasBrainArea = await dirExists(brainArea);

	return {
		name,
		devPath: hasDev ? devPath : null,
		brainPath: hasBrainProject ? brainProject : hasBrainArea ? brainArea : null,
		cwd: hasDev ? devPath : HOME,
	};
};
