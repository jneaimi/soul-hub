/**
 * Template definitions for project scaffolding.
 * Each template defines what files/folders to create in ~/dev/ and ~/SecondBrain/.
 */

export interface TemplateVariant {
	id: string;
	label: string;
}

export interface Template {
	id: string;
	name: string;
	description: string;
	icon: string; // SVG path(s)
	color: string; // hub-* token name
	variants?: TemplateVariant[];
	defaultSkills: string[];
	defaultAgents: string[];
	brainArea: '01-projects' | '02-areas';
	brainFolders: string[];
	devFiles: (name: string, variant?: string) => Record<string, string>;
	brainFiles: (name: string) => Record<string, string>;
}

function today(): string {
	return new Date().toISOString().split('T')[0];
}

function claudeMdDev(name: string, variant?: string): string {
	const v = variant || 'general';
	const buildCmds: Record<string, string> = {
		sveltekit: `npm run dev    # development server
npm run build  # production build
npm run check  # svelte-check + tsc`,
		nextjs: `npm run dev    # development server
npm run build  # production build
npm run lint   # eslint`,
		python: `uv run main.py          # run with uv
uv run pytest tests/    # run tests`,
		cli: `npm run build   # compile
npm run test    # run tests
node dist/index.js  # run`,
		general: `# Add build & run commands here`,
	};
	return `# ${name}

## Build & Run
\`\`\`bash
${buildCmds[v] || buildCmds.general}
\`\`\`

## Code Style
<!-- Only document non-default conventions -->

## Architecture
<!-- Brief overview — link to @~/SecondBrain/ for detail -->

## Gotchas
<!-- Things that trip Claude up in this codebase -->

## Environment
<!-- Required env vars and how to get them -->
`;
}

function claudeMdContent(name: string): string {
	return `# ${name}

## Content Types
<!-- What content this project produces -->

## Brand Voice
<!-- Tone, style, audience -->

## Publishing Workflow
<!-- Draft → review → publish steps -->

## Environment
<!-- API keys, CMS credentials -->
`;
}

function claudeMdResearch(name: string): string {
	return `# ${name}

## Scope
<!-- What topics/markets this research covers -->

## Sources
<!-- Preferred platforms and data sources -->

## Report Format
<!-- Structure for research outputs -->

## Environment
<!-- API keys for data collection -->
`;
}

function claudeMdMedia(name: string): string {
	return `# ${name}

## Brand Assets
<!-- Logo, colors, fonts -->

## Output Formats
<!-- Aspect ratios, file types, quality settings -->

## Arabic Rules
<!-- Gemini cannot render Arabic — use overlay script -->

## Environment
<!-- GOOGLE_API_KEY, ELEVENLABS_API_KEY -->
`;
}

function claudeMdOps(name: string): string {
	return `# ${name}

## Infrastructure
<!-- Services, servers, URLs -->

## Runbooks
<!-- Link to runbooks in brain docs -->

## Monitoring
<!-- Dashboard URLs, alert channels -->

## Escalation
<!-- Who to contact, when -->
`;
}

function claudeMdCustom(name: string): string {
	return `# ${name}

## Build & Run
<!-- Add commands here -->

## Architecture
<!-- Brief overview -->

## Environment
<!-- Required env vars -->
`;
}

function settingsJson(template: string): string {
	const base: Record<string, unknown> = {};
	if (template === 'operations') {
		base.hooks = {
			PreToolUse: [
				{
					matcher: 'Bash',
					hook: 'echo "⚠️  Review destructive commands carefully"',
				},
			],
		};
	}
	return JSON.stringify(base, null, 2);
}

function gitignore(): string {
	return `.env
.env.*
!.env.example
node_modules/
dist/
build/
.claude/settings.local.json
CLAUDE.local.md
*.pyc
__pycache__/
.DS_Store
`;
}

function projectMd(name: string, type: string): string {
	return `---
type: project
created: ${today()}
tags: [${type}]
status: active
---

# ${name}

## Goals
<!-- What this project aims to achieve -->

## Status
- [ ] Initial setup
- [ ] First milestone

## Links
- Dev: \`~/dev/${name}/\`
- Brain: this folder
`;
}

function indexMd(name: string): string {
	return `# ${name} — Index

## Files
- [project.md](project.md) — Goals, status, links
`;
}

export const templates: Template[] = [
	{
		id: 'development',
		name: 'Development',
		description: 'Full-stack web apps, APIs, CLI tools',
		icon: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
		color: 'hub-cta',
		variants: [
			{ id: 'sveltekit', label: 'SvelteKit' },
			{ id: 'nextjs', label: 'Next.js' },
			{ id: 'python', label: 'Python' },
			{ id: 'cli', label: 'CLI Tool' },
		],
		defaultSkills: ['deploy', 'test-coverage', 'code-review'],
		defaultAgents: ['security-reviewer', 'performance-reviewer'],
		brainArea: '01-projects',
		brainFolders: ['decisions', 'diagrams'],
		devFiles: (name, variant) => ({
			'CLAUDE.md': claudeMdDev(name, variant),
			'CLAUDE.local.md': '<!-- Local overrides — gitignored -->\n',
			'.claude/settings.json': settingsJson('development'),
			'.claude/rules/.gitkeep': '',
			'.claude/skills/.gitkeep': '',
			'.claude/agents/.gitkeep': '',
			'.gitignore': gitignore(),
		}),
		brainFiles: (name) => ({
			'project.md': projectMd(name, 'development'),
			'index.md': indexMd(name),
		}),
	},
	{
		id: 'content',
		name: 'Content',
		description: 'Writing, publishing, brand content',
		icon: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
		color: 'hub-purple',
		defaultSkills: ['draft'],
		defaultAgents: ['arabic-writer', 'editor'],
		brainArea: '01-projects',
		brainFolders: ['drafts', 'content-bank'],
		devFiles: (name) => ({
			'CLAUDE.md': claudeMdContent(name),
			'CLAUDE.local.md': '<!-- Local overrides — gitignored -->\n',
			'.claude/settings.json': settingsJson('content'),
			'.claude/rules/.gitkeep': '',
			'.claude/skills/.gitkeep': '',
			'.claude/agents/.gitkeep': '',
			'.gitignore': gitignore(),
		}),
		brainFiles: (name) => ({
			'project.md': projectMd(name, 'content'),
			'index.md': indexMd(name),
		}),
	},
	{
		id: 'research',
		name: 'Research',
		description: 'Market research, trend analysis, reports',
		icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
		color: 'hub-info',
		defaultSkills: ['collect'],
		defaultAgents: ['researcher'],
		brainArea: '01-projects',
		brainFolders: ['reports', 'signals'],
		devFiles: (name) => ({
			'CLAUDE.md': claudeMdResearch(name),
			'CLAUDE.local.md': '<!-- Local overrides — gitignored -->\n',
			'.claude/settings.json': settingsJson('research'),
			'.claude/rules/.gitkeep': '',
			'.claude/skills/.gitkeep': '',
			'.claude/agents/.gitkeep': '',
			'.gitignore': gitignore(),
		}),
		brainFiles: (name) => ({
			'project.md': projectMd(name, 'research'),
			'index.md': indexMd(name),
		}),
	},
	{
		id: 'media',
		name: 'Media',
		description: 'Images, video, voiceovers, design',
		icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
		color: 'hub-warning',
		defaultSkills: ['generate'],
		defaultAgents: ['media-creator'],
		brainArea: '01-projects',
		brainFolders: ['assets', 'briefs', 'media-library'],
		devFiles: (name) => ({
			'CLAUDE.md': claudeMdMedia(name),
			'CLAUDE.local.md': '<!-- Local overrides — gitignored -->\n',
			'.claude/settings.json': settingsJson('media'),
			'.claude/rules/.gitkeep': '',
			'.claude/skills/.gitkeep': '',
			'.claude/agents/.gitkeep': '',
			'.gitignore': gitignore(),
		}),
		brainFiles: (name) => ({
			'project.md': projectMd(name, 'media'),
			'index.md': indexMd(name),
		}),
	},
	{
		id: 'operations',
		name: 'Operations',
		description: 'DevOps, monitoring, infrastructure',
		icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
		color: 'hub-danger',
		defaultSkills: ['health-check', 'deploy'],
		defaultAgents: ['sentinel', 'watchtower'],
		brainArea: '02-areas',
		brainFolders: ['runbooks', 'audits', 'incidents'],
		devFiles: (name) => ({
			'CLAUDE.md': claudeMdOps(name),
			'CLAUDE.local.md': '<!-- Local overrides — gitignored -->\n',
			'.claude/settings.json': settingsJson('operations'),
			'.claude/rules/.gitkeep': '',
			'.claude/skills/.gitkeep': '',
			'.claude/agents/.gitkeep': '',
			'.gitignore': gitignore(),
		}),
		brainFiles: (name) => ({
			'project.md': projectMd(name, 'operations'),
			'index.md': indexMd(name),
		}),
	},
	{
		id: 'custom',
		name: 'Custom',
		description: 'Blank slate — pick your own skills & agents',
		icon: 'M12 6v6m0 0v6m0-6h6m-6 0H6',
		color: 'hub-dim',
		defaultSkills: [],
		defaultAgents: [],
		brainArea: '01-projects',
		brainFolders: [],
		devFiles: (name) => ({
			'CLAUDE.md': claudeMdCustom(name),
			'CLAUDE.local.md': '<!-- Local overrides — gitignored -->\n',
			'.claude/settings.json': settingsJson('custom'),
			'.claude/rules/.gitkeep': '',
			'.claude/skills/.gitkeep': '',
			'.claude/agents/.gitkeep': '',
			'.gitignore': gitignore(),
		}),
		brainFiles: (name) => ({
			'project.md': projectMd(name, 'custom'),
			'index.md': indexMd(name),
		}),
	},
];

export function getTemplate(id: string): Template | undefined {
	return templates.find((t) => t.id === id);
}
