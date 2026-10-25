// Who may use the hub and its review proxy (ADR 0001). The one place a later identity check goes
// (a Tailscale-User-Login allowlist, a Cloudflare Access JWT, a pairing cookie). Review servers keep localOnly.
import type { Context } from 'hono';
import { accessRequest, loopbackHosts, sameSite, serverPort, type AccessRequest } from '../lib/server.ts';

// the hub's name on this Mac (`portless alias reviewroom 4847`): portless passes its own Host through.
// shortcut: hard-coded to the reviewer's portless setup, make it a setting if anyone else runs the hub
export const LOCAL_ORIGIN = 'https://reviewroom.localhost:1355';

// the hub's API and every proxied review's API: cross-site checks apply to both (the proxy rewrites Origin)
const isApi = (p: string) => /^\/(r\/[^/]+\/)?api\//.test(p);

/** Loopback as on a review server, or Host equal to the portless name's or the public origin's host; on the APIs no
 *  cross-site requests, and writes carry no Origin or one of those. Pure, for tests. */
export function hubAllows(r: AccessRequest, port: number | undefined, publicOrigin: string | null) {
  const named = [new URL(LOCAL_ORIGIN), ...(publicOrigin ? [new URL(publicOrigin)] : [])];
  const loop = loopbackHosts(port);
  return sameSite(r, [...loop, ...named.map((u) => u.host)], [...loop.map((h) => `http://${h}`), ...named.map((u) => u.origin)], isApi);
}

export const hubAccess = (c: Context, publicOrigin: string | null) => hubAllows(accessRequest(c), serverPort(c), publicOrigin);
