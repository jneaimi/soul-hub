/**
 * Soul Hub skills registry — types.
 *
 * Skills live at `~/.claude/skills/<name>/` with a required `SKILL.md` at the
 * root. The format is owned by Anthropic (see https://code.claude.com/docs/en/skills);
 * this module reads the frontmatter, surfaces it in the UI, and provides a
 * thin install/uninstall layer. We never modify SKILL.md content — installs
 * are atomic copy/clone, uninstalls are atomic remove.
 */

export interface SkillSummary {
	/** Directory name under `~/.claude/skills/` — also the install id. */
	id: string;
	/** Frontmatter `name` (falls back to `id` when missing). */
	name: string;
	/** Frontmatter `description` (single-line). Empty when missing/unparseable. */
	description: string;
	/** Body length in lines (post-frontmatter). Zero when SKILL.md is missing. */
	body_lines: number;
	/** True when `<dir>/scripts/` exists. */
	has_scripts: boolean;
	/** True when `<dir>/references/` exists. */
	has_references: boolean;
	/** True when the dir itself is a symlink — uninstall removes the symlink only. */
	is_symlink: boolean;
	/** When `is_symlink` is true, the resolved target path (best-effort). */
	symlink_target?: string;
	/** Absolute path to `SKILL.md`. */
	source_path: string;
	/** Mtime of SKILL.md (epoch ms) — surfaced in UI as "last modified". */
	modified_at: number;
	/** Frontmatter-level parse error, when present. Skill still listed but flagged. */
	parse_error?: string;
}

export interface SkillDetail extends SkillSummary {
	/** Full SKILL.md body (post-frontmatter). Truncated to 8 KB for the UI. */
	body_preview: string;
	/** True when body was truncated. */
	body_truncated: boolean;
	/** Raw frontmatter object — for advanced/debug surfaces. */
	frontmatter: Record<string, unknown>;
}

export type InstallSource = 'github' | 'anthropic-registry' | 'curated';

export interface InstallRequest {
	source: InstallSource;
	/** `owner/repo` or a full https URL. Required. */
	repo: string;
	/** Optional subpath inside the repo to install from. */
	subpath?: string;
	/** Optional override id. Defaults to subpath basename or repo name. */
	name?: string;
	/** Optional ref/branch/tag (defaults to repo HEAD). */
	ref?: string;
}

export interface InstallResult {
	id: string;
	source_path: string;
	frontmatter: Record<string, unknown>;
}
