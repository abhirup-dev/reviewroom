// Who may use the hub and its review proxy (ADR 0001). The one place a later identity check goes
// (a Tailscale-User-Login allowlist, a Cloudflare Access JWT, a pairing cookie). Review servers keep localOnly.
import type { Context } from 'hono';
import { accessRequest, loopbackHosts, sameSite, serverPort, type AccessRequest } from '../lib/server.ts';

// the hub's API and every proxied review's API: cross-site checks apply to both (the proxy rewrites Origin)
const isApi = (p: string) => /^\/(r\/[^/]+\/)?api\//.test(p);

/** Loopback as on a review server, or Host equal to the public origin's host; on the APIs no cross-site requests,
 *  and writes carry no Origin or a loopback one or the public origin. Pure, for tests. */
export function hubAllows(r: AccessRequest, port: number | undefined, publicOrigin: string | null) {
  const loop = loopbackHosts(port);
  const pub = publicOrigin ? new URL(publicOrigin) : null;
  return sameSite(r, pub ? [...loop, pub.host] : loop, [...loop.map((h) => `http://${h}`), ...(pub ? [pub.origin] : [])], isApi);
}

export const hubAccess = (c: Context, publicOrigin: string | null) => hubAllows(accessRequest(c), serverPort(c), publicOrigin);
