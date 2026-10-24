/** Decode JSON or surface the server's {error}, GitHub's {message}, or HTTP status. */
export const json = async (r: Response) => {
  if (r.ok) return r.json();
  const b = await r.json().catch(() => null);
  throw new Error(b?.error ?? b?.message ?? `${r.status} ${r.statusText} ${r.url}`);
};

/** A request with a JSON body. */
export const sendJSON = (url: string, method: 'POST' | 'PUT', body: unknown, init?: RequestInit) =>
  fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
