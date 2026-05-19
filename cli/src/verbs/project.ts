import { apiGet, apiPost, apiPut } from '../api.ts';
import { emit, fail, ageDays, todayIso, exitIfApiFailure, type OutputOpts } from '../output.ts';

/** projects-graph ADR-001 — canonical shape enum. Kept in lockstep with
 *  `PROJECT_SHAPES` in `src/lib/vault/types.ts` and the `## Allowed Project
 *  Shapes` section in `~/vault/projects/CLAUDE.md`. Used by `label-shape`. */
const PROJECT_SHAPES = [
  'coding-spine',
  'producer-pipeline',
  'publishing-outlet',
  'strategy-initiative',
  'time-boxed-bet',
  'maintained-system',
  'parent',
] as const;

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

/** projects-graph ADR-005 — project-level graph response shape returned
 *  by `/api/vault/projects/graph`. Mirrors `ProjectGraphData` in
 *  `src/lib/vault/types.ts`; kept local so this CLI has no runtime
 *  dependency on the Svelte app build output. */
interface GraphNodeLite {
  id: string;
  label: string;
  shape?: string;
  cluster?: string;
  parent?: string | null;
  size: number;
  aggregateStatus?: { open: number; shipped: number; total: number };
  hasOverdueFalsifier?: boolean;
}
interface GraphEdgeLite {
  source: string;
  target: string;
  type?: string;
}
interface ProjectGraphResp {
  nodes: GraphNodeLite[];
  edges: GraphEdgeLite[];
  clusters: Array<{ name: string; member_slugs: string[] }>;
}

function slugFromId(id: string): string {
  return id.replace(/^projects\//, '').replace(/\/index\.md$/i, '');
}

function emitDot(g: ProjectGraphResp): string {
  const lines: string[] = ['digraph projects {'];
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=rounded];');
  // Cluster subgraphs — dot uses `cluster_` prefix to draw boxes.
  for (const c of g.clusters) {
    if (c.name === 'ungrouped' || c.member_slugs.length === 0) continue;
    lines.push(`  subgraph cluster_${c.name.replace(/[^a-z0-9]/gi, '_')} {`);
    lines.push(`    label="cluster:${c.name}";`);
    for (const slug of c.member_slugs) lines.push(`    "${slug}";`);
    lines.push('  }');
  }
  for (const e of g.edges) {
    const src = slugFromId(e.source);
    const tgt = slugFromId(e.target);
    const style = e.type === 'parent' ? ' [color="#94a3b8"]' : '';
    lines.push(`  "${src}" -> "${tgt}"${style};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function emitAdjacencyList(g: ProjectGraphResp): string {
  // Group edges by source slug, then format `<src> -> <tgt1>, <tgt2>`.
  const out = new Map<string, string[]>();
  for (const e of g.edges) {
    const src = slugFromId(e.source);
    const tgt = slugFromId(e.target);
    const list = out.get(src) ?? [];
    list.push(tgt);
    out.set(src, list);
  }
  const lines: string[] = [];
  // Walk in node order so unconnected projects still appear (with empty list).
  for (const n of g.nodes) {
    const slug = slugFromId(n.id);
    const children = out.get(slug) ?? [];
    const tail = children.length > 0 ? ' → ' + children.sort().join(', ') : '';
    const shape = n.shape ? ` [${n.shape}]` : '';
    const cluster = n.cluster ? ` (cluster:${n.cluster})` : '';
    lines.push(`${slug}${shape}${cluster}${tail}`);
  }
  return lines.join('\n');
}

export async function graph(args: Record<string, string | undefined>, opts: OutputOpts) {
  const format = (args.format ?? 'adjacency-list').toLowerCase();
  if (!['json', 'adjacency-list', 'dot'].includes(format)) {
    fail(`project graph: unknown --format "${format}". Allowed: json, adjacency-list, dot`);
  }

  const data = await apiGet<ProjectGraphResp>('/api/vault/projects/graph');

  // `--json` always wins (matches the global flag contract) and emits
  // the raw API JSON. `--format json` is the same thing for explicit
  // call-site readability.
  if (opts.json || format === 'json') {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  const rendered = format === 'dot' ? emitDot(data) : emitAdjacencyList(data);
  process.stdout.write(rendered + '\n');
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

/** projects-graph ADR-001 — set the `project_shape:` frontmatter on a
 *  project root `index.md` via the vault chokepoint (PUT /api/vault/notes).
 *  Validates the value against the canonical enum BEFORE the HTTP call so
 *  errors point at the CLI (not the API) when the operator fat-fingers a
 *  shape. Supports `--dry-run`.
 *
 *  Usage:
 *    soul project label-shape <slug> --shape <shape>
 *    soul project label-shape <slug> <shape>      (positional shape)
 */
export async function labelShape(args: Record<string, string | undefined>, opts: OutputOpts) {
  // `args._` packs all positionals as `slug/shape` per index.ts:139.
  const positionals = (args._ ?? '').split('/').filter(Boolean);
  const slug = positionals[0];
  const shape = args.shape ?? positionals[1];

  if (!slug) fail('project label-shape: missing SLUG (e.g. soul project label-shape soul-hub --shape coding-spine)');
  if (!shape) fail('project label-shape: missing SHAPE (--shape coding-spine; one of: ' + PROJECT_SHAPES.join(', ') + ')');
  if (!(PROJECT_SHAPES as readonly string[]).includes(shape)) {
    fail(`project label-shape: invalid shape "${shape}". Allowed: ${PROJECT_SHAPES.join(', ')}`);
  }

  const path = `projects/${slug}/index.md`;
  const body = {
    meta: {
      project_shape: shape,
      // Stamp WHO labelled and WHEN for the Day 1-7 sweep audit trail.
      source_agent: 'soul-cli',
      source_context: `soul project label-shape ${slug} ${shape} (${todayIso()})`,
    },
  };

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'PUT', path: `/api/vault/notes/${path}`, body }, opts, (d: any) =>
      `DRY RUN — PUT /api/vault/notes/${path}\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPut<WriteResp>(`/api/vault/notes/${path}`, body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ labelled ${slug} → project_shape: ${shape}`,
  );
  exitIfApiFailure(data);
}
