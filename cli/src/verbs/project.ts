import { apiGet, apiPost } from '../api.ts';
import { emit, fail, ageDays, todayIso, exitIfApiFailure, type OutputOpts } from '../output.ts';

interface ProjectRow {
  slug: string;
  parentProject?: string | null;
  adrCount: number;
  noteCount: number;
  statusCounts: Record<string, number>;
  openCount: number;
  lastActivity?: number | null;
  hasIndex: boolean;
  indexPath?: string;
  upcomingFalsifiers?: Array<{ slug: string; date: string }>;
}
interface ProjectsResp { projects: ProjectRow[]; total: number; }

export async function list(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<ProjectsResp>('/api/vault/projects');
  emit(data, opts, (d: ProjectsResp) => {
    if (d.projects.length === 0) return '(no projects)';
    const rows = d.projects
      .slice()
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
      .map((p) => {
        const parent = p.parentProject ? ` ← ${p.parentProject}` : '';
        return `${p.slug.padEnd(28)} adrs=${String(p.adrCount).padEnd(3)} open=${String(p.openCount).padEnd(3)} ${ageDays(p.lastActivity ?? null)}${parent}`;
      });
    return rows.join('\n');
  });
}

export async function get(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project get: missing SLUG (e.g. soul project get soul-hub-cli)');
  const data = await apiGet<ProjectsResp>('/api/vault/projects', { slug });
  const row = data.projects.find((p) => p.slug === slug) ?? data.projects[0];
  if (!row) fail(`project get: no project named "${slug}"`, 2);
  emit(row, opts, (p: ProjectRow) => {
    const lines = [
      `Project: ${p.slug}`,
      p.parentProject ? `Parent:  ${p.parentProject}` : 'Parent:  (top-level)',
      `Index:   ${p.indexPath ?? '(missing)'}`,
      `ADRs:    ${p.adrCount} total | ${p.openCount} open`,
      `Last:    ${ageDays(p.lastActivity ?? null)}`,
      '',
      'Status counts:',
      ...Object.entries(p.statusCounts).map(([k, v]) => `  ${k.padEnd(12)} ${v}`),
    ];
    if (p.upcomingFalsifiers && p.upcomingFalsifiers.length > 0) {
      lines.push('', 'Upcoming falsifiers:');
      for (const f of p.upcomingFalsifiers) lines.push(`  ${f.date}  ${f.slug}`);
    }
    return lines.join('\n');
  });
}

interface WriteResp { success?: boolean; path?: string; error?: string }

export async function create(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.slug) fail('project create: --slug is required');
  const slug = args.slug;
  const today = todayIso();

  const meta: Record<string, unknown> = {
    type: 'index',
    status: 'maintained',
    created: today,
    updated: today,
    project: slug,
    tags: args.parent ? [`cluster:${args.parent}`, args.parent, slug] : [slug],
    source_agent: 'soul-cli',
    source_context: `Project created via soul project create on ${today}`,
  };
  if (args.parent) meta.parent_project = `[[${args.parent}|${args.parent}]]`;

  // Merge in --meta-json overrides last so the caller wins.
  if (args['meta-json']) {
    try {
      Object.assign(meta, JSON.parse(args['meta-json']));
    } catch (err) {
      fail(`--meta-json: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const title = args.title ?? slug;
  const content = `# ${title}\n\n> Project home for **${slug}**. Created by \`soul project create\` ${today}.\n\n## Documents\n\n(no decisions yet)\n\n## Related\n\n${args.parent ? `- [[../${args.parent}/index|${args.parent}]] — parent project.\n` : ''}`;

  const body = { zone: `projects/${slug}`, filename: 'index.md', meta, content };

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'POST', path: '/api/vault/notes', body }, opts, (d: any) =>
      `DRY RUN — POST /api/vault/notes\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPost<WriteResp>('/api/vault/notes', body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ created project ${slug} → ${d.path ?? `projects/${slug}/index.md`}`,
  );
  exitIfApiFailure(data);
}
