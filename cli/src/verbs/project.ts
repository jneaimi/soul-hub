import { apiGet } from '../api.ts';
import { emit, fail, ageDays, type OutputOpts } from '../output.ts';

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
