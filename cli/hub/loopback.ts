// Validation of what other tools' registries say: strict numbers, loopback-only URLs, timestamps.
// Anything the hub links to must resolve to loopback; remote hosts, tunnels and junk are dropped.

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return h.split('.').every((p) => +p <= 255);
  return false;
}

/** A TCP port: an integer in range, never a string or float. */
export function parseStrictPort(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null;
}

/** A pid: a positive integer below the macOS PID_MAX. */
export function parseStrictPid(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4194304 ? v : null;
}

export interface SanitizedUrl {
  url: string | null;
  note: string | null;
}

/** Only http(s) URLs whose host is loopback. */
export function sanitizeLoopbackUrl(raw: unknown): SanitizedUrl {
  if (typeof raw !== 'string' || raw.trim() === '') return { url: null, note: 'no url recorded' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { url: null, note: 'unparsable url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: null, note: `unsupported protocol ${u.protocol}` };
  if (!isLoopbackHost(u.hostname)) return { url: null, note: 'non-loopback host ignored' };
  return { url: u.toString(), note: null };
}

/** Crit records `host` as "127.0.0.1" (or empty); a daemon bound anywhere else is not linked. */
export function critLoopbackUrl(host: string, port: number): SanitizedUrl {
  if (host !== '' && !isLoopbackHost(host)) return { url: null, note: `non-loopback host "${host}" ignored` };
  return { url: `http://localhost:${port}`, note: null }; // crit's own display form
}

/** An ISO timestamp, sub-millisecond digits dropped (crit writes nanoseconds); null for junk. */
export function normalizeTimestamp(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const s = v.trim().replace(/(\.\d{3})\d+/, '$1');
  return Number.isFinite(Date.parse(s)) ? s : null;
}
