import { apiGet } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

interface AdrHit {
  path: string;
  title?: string;
  type?: string;
  project?: string;
  tags?: string[];
  snippet?: string;
}
interface SearchResp { results: AdrHit[]; total?: number; }

export async function list(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.project) fail('adr list: --project SLUG is required');
  const data = await apiGet<SearchResp>('/api/vault/notes', {
    project: args.project,
    type: 'decision',
    limit: args.limit ?? '100',
  });
  emit(data, opts, (d: SearchResp) =>
    d.results.length === 0
      ? '(no ADRs)'
      : d.results
          .map((r) => {
            const file = (r.path.split('/').pop() ?? r.path).padEnd(60);
            return `${file}  ${r.title ?? ''}`;
          })
          .join('\n')
  );
}
