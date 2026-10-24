// The hub's HTTP API and page, on 127.0.0.1 like a review server and behind the same guard.
//   GET  /                          the page (dist/hub.js, dist/hub.css)
//   GET  /api/sessions              HubSnapshot; polls when the last poll is older than half the interval
//   GET  /api/health                counters and the Crit/Plannotator versions against the verified ones
//   POST /api/sessions/:id/close    SIGTERM a session a fresh poll still finds (needs x-reviewroom-action: close-session)
//   ALL  /r/<review id>/*           the review whose dir hashes to the id, proxied to its server (ADR 0001)
// Behind hubAccess: loopback, or the configured public origin.
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { hubAccess } from './access.ts';
import { assessCompatibility } from './compat.ts';
import type { Hub } from './hub.ts';
import { guarded, PWA_HEAD, serveClient } from '../lib/server.ts';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>All reviews - reviewroom</title>
${PWA_HEAD}<link rel="stylesheet" href="/_rr/hub.css">
<script type="module" src="/_rr/hub.js"></script>
</head>
<body></body>
</html>
`;

/** `publicOrigin`: the origin a front (tailscale serve, a tunnel) serves the hub at, from ~/.reviewroom/config.json. */
export function hubApp(hub: Hub, publicOrigin: string | null = null) {
  const started = Date.now();
  const app = new Hono();
  app.use(guarded((c) => hubAccess(c, publicOrigin)));
  app.use(compress()); // the phone's link is the slow one: compress here, proxied responses included
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.get('/', (c) => c.html(PAGE, 200, { 'cache-control': 'no-cache' }));
  serveClient(app);
  app.get('/favicon.ico', (c) => c.body(null, 204));
  // hubAccess passed: the review server gets its own loopback Host and Origin, and checks the rest itself
  app.all('/r/:id{[0-9a-f]{12}}', (c) => c.redirect(c.req.path + '/'));
  app.all('/r/:id{[0-9a-f]{12}}/*', async (c) => {
    const id = c.req.param('id');
    const s = await hub.review(id);
    if (!s) return c.json({ error: 'no running review with that id' }, 404);
    const up = `127.0.0.1:${s.port}`;
    const u = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    headers.set('host', up);
    headers.set('accept-encoding', 'identity'); // loopback: the review answers plain (fetch adds gzip if unset), the compress above encodes once
    if (headers.has('origin')) headers.set('origin', `http://${up}`);
    try {
      const res = await fetch(`http://${up}${u.pathname.slice(`/r/${id}`.length)}${u.search}`, { method: c.req.method, headers, body: c.req.raw.body, redirect: 'manual', signal: c.req.raw.signal });
      // another process took the port since the last poll: say nothing of what it answered
      if (res.headers.get('x-reviewroom-pid') !== String(s.pid)) return (void res.body?.cancel(), c.json({ error: 'the review server is gone' }, 502));
      return new Response(res.body, res); // as the review sent it (its cache, pid and build headers), with headers compress can set
    } catch (e) {
      return c.json({ error: `the review server did not answer: ${(e as Error).message}` }, 502);
    }
  });
  app.get('/api/sessions', async (c) => {
    await hub.fresh();
    return c.json(hub.snapshot());
  });
  app.get('/api/health', async (c) => {
    await hub.fresh();
    const snap = hub.snapshot();
    const versions = await hub.toolVersions();
    const sessionCounts: Record<string, number> = { crit: 0, plannotator: 0, reviewroom: 0 };
    for (const s of snap.sessions) sessionCounts[s.tool]++;
    return c.json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      pollIntervalMs: hub.pollIntervalMs,
      lastPollAt: hub.lastPollAtMs ? new Date(hub.lastPollAtMs).toISOString() : null,
      sessionCounts,
      lastError: snap.lastError,
      versions,
      compatibility: assessCompatibility(versions),
    });
  });
  app.post('/api/sessions/:id/close', async (c) => {
    // a header a cross-site form cannot send (and a cross-site fetch cannot without a preflight we never allow)
    if (c.req.header('x-reviewroom-action') !== 'close-session') return c.json({ error: 'missing action confirmation header' }, 403);
    const result = await hub.closeSession(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not-found' ? 404 : 409);
    return c.json({ ok: true, id: result.session.id, pid: result.session.pid, signal: 'SIGTERM' }, 202);
  });
  return app;
}
