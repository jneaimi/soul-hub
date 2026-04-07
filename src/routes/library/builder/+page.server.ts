import type { PageServerLoad } from './$types';
import { resolve, dirname } from 'node:path';
import { config } from '$lib/config.js';

export const load: PageServerLoad = async () => {
	// Builder lives in pipelines/_builder/ inside the Soul Hub project
	const builderDir = resolve(dirname(config.resolved.catalogDir), 'pipelines', '_builder');

	return {
		cwd: builderDir,
	};
};
