// The hub's HTTP API and page, on 127.0.0.1 like a review server and behind the same guard.
//   GET  /                          the page (dist/hub.js, dist/hub.css)
//   GET  /api/sessions              HubSnapshot; polls when the last poll is older than half the interval
//   GET  /api/health                counters and the Crit/Plannotator versions against the verified ones
//   POST /api/sessions/:id/close    SIGTERM a session a fresh poll still finds (needs x-reviewroom-action: close-session)
//   POST /api/reviews               { url }: Add a PR (needs x-reviewroom-action: add-review)
//   POST /api/reviews/:routeId/play      start a stopped review, or find the running one (play-review)
//   POST /api/reviews/:routeId/remove    delete a stopped review's folder; a running one is refused (remove-review)
//   ALL  /r/<hash>/*                the review whose directory has this hash, proxied to its server (ADR 0001)
// Behind hubAccess: loopback, or the configured public origin.
import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { hubAccess } from './access.ts';
import { assessCompatibility } from './compat.ts';
import type { Hub } from './hub.ts';
import { guarded } from '../lib/server.ts';
import { PWA_HEAD, serveClient } from '../lib/pwa.ts';
import { serveProxy } from './proxy.ts';
import { addPr, play, remove } from './reviews.ts';

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
  app.use(compress()); // the phone's link is the slow one; proxied reviews arrive already encoded by their own server
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.get('/', (c) => c.html(PAGE, 200, { 'cache-control': 'no-cache' }));
  serveClient(app);
  app.get('/favicon.ico', (c) => c.body(null, 204));
  serveProxy(app, hub);
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
  // a header a cross-site form cannot send, as for close
  const action = (c: Context, name: string) => c.req.header('x-reviewroom-action') === name;
  const refused = (c: Context) => c.json({ error: 'missing action confirmation header' }, 403);
  app.post('/api/reviews', async (c) => {
    if (!action(c, 'add-review')) return refused(c);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    const r = await addPr(typeof body.url === 'string' ? body.url : '', hub.entry);
    hub.invalidate();
    return r.ok ? c.json({ ok: true, routeId: r.routeId, running: r.running }, 201) : c.json({ error: r.error }, 422);
  });
  app.post('/api/reviews/:routeId/play', async (c) => {
    if (!action(c, 'play-review')) return refused(c);
    const r = await play(c.req.param('routeId'), hub.entry);
    hub.invalidate();
    return r.ok ? c.json(r) : c.json({ error: r.error }, 409);
  });
  app.post('/api/reviews/:routeId/remove', async (c) => {
    if (!action(c, 'remove-review')) return refused(c);
    const body = (await c.req.json().catch(() => null)) as { confirmed?: unknown } | null;
    const r = await remove(c.req.param('routeId'), body?.confirmed === true);
    hub.invalidate();
    return r.ok ? c.json(r) : c.json({ error: r.error }, r.status);
  });
  return app;
}
