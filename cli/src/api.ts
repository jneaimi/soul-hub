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

async function request<T>(method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T> {
  const url = new URL(path, baseUrl() + '/');
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { method, headers, body });
  } catch (err) {
    throw new ApiError(
      0,
      err instanceof Error ? err.message : String(err),
      url.pathname + url.search,
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

export function apiGet<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  return request<T>('GET', path, { query });
}

export function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, { body });
}

export function apiPut<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, { body });
}
