import type { RequestHandler } from './$types';
import { listSkills, skillsDir } from '$lib/skills/index.js';
import { json } from '@sveltejs/kit';

export const GET: RequestHandler = async () => {
	const skills = listSkills();
	return json({
		skills,
		dir: skillsDir(),
		count: skills.length,
	});
};
