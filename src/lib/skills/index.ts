/**
 * Public surface for the skills module. Other modules import from here only.
 */

export type {
	SkillSummary,
	SkillDetail,
	InstallSource,
	InstallRequest,
	InstallResult,
} from './types.js';
export { listSkills, getSkill, skillsDir, skillExists } from './store.js';
export { installSkill, uninstallSkill, parseRepo } from './installer.js';
export { readSkillBody } from './prompt.js';
