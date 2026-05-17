// Thin fetch wrapper around the Soul Hub API. Dumb pipe per ADR-001 — no
// validation, no caching, no auth logic. Errors surface verbatim.

const DEFAULT_BASE = 'http://localhost:2400';

export function baseUrl(): string {
  return process.env.SOUL_HUB_URL?.replace(/\/+$/, '') || DEFAULT_BASE;
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, path: string) {
    super(`API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export async function apiGet<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, baseUrl() + '/');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ApiError(
      0,
      err instanceof Error ? err.message : String(err),
      url.pathname + url.search
    );
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text, url.pathname + url.search);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, `non-JSON response: ${text.slice(0, 200)}`, url.pathname + url.search);
  }
}
