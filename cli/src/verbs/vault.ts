import { apiGet } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

interface Hit { path: string; title?: string; score?: number; meta?: Record<string, unknown>; }
interface SearchResp { results: Hit[]; total?: number; }

export async function search(args: Record<string, string | undefined>, opts: OutputOpts) {
  const q = args.q ?? args._;
  if (!q && !args.zone && !args.project && !args.type) {
    fail('vault search: need at least one of -q QUERY, --zone, --project, --type');
  }
  const data = await apiGet<SearchResp>('/api/vault/notes', {
    q,
    zone: args.zone,
    project: args.project,
    type: args.type,
    limit: args.limit ?? '20',
  });
  emit(data, opts, (d: SearchResp) =>
    d.results.length === 0
      ? '(no matches)'
      : d.results.map((h) => `${h.path}  —  ${h.title ?? ''}`).join('\n')
  );
}

interface NoteDetail { path: string; title?: string; content?: string; meta?: Record<string, unknown>; }

export async function get(args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  if (!path) fail('vault get: missing PATH (e.g. soul vault get projects/foo/index.md)');
  const data = await apiGet<NoteDetail>(`/api/vault/notes/${path}`);
  emit(data, opts, (d: NoteDetail) => {
    const head = `# ${d.title ?? d.path}`;
    const body = d.content ?? '(no content)';
    return `${head}\n\n${body}`;
  });
}

interface RecentResp { notes: Array<{ path: string; title?: string; mtime?: number }>; }

export async function recent(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<RecentResp>('/api/vault/recent', { limit: args.limit ?? '20' });
  emit(data, opts, (d: RecentResp) =>
    d.notes.map((n) => `${n.path}  —  ${n.title ?? ''}`).join('\n')
  );
}
