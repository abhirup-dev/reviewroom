// The hub's HTTP API and page, on 127.0.0.1 like a review server and behind the same guard.
//   GET  /                          the page (dist/hub.js, dist/hub.css)
//   GET  /api/sessions              HubSnapshot; polls when the last poll is older than half the interval
//   GET  /api/health                counters and the Crit/Plannotator versions against the verified ones
//   POST /api/sessions/:id/close    SIGTERM a session a fresh poll still finds (needs x-reviewroom-action: close-session)
import { Hono } from 'hono';
import { assessCompatibility } from './compat.ts';
import type { Hub } from './hub.ts';
import { localOnly, serveClient } from '../lib/server.ts';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All reviews - reviewroom</title>
<link rel="stylesheet" href="/_rr/hub.css">
<script type="module" src="/_rr/hub.js"></script>
</head>
<body></body>
</html>
`;

export function hubApp(hub: Hub) {
  const started = Date.now();
  const app = new Hono();
  app.use(localOnly);
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.get('/', (c) => c.html(PAGE, 200, { 'cache-control': 'no-cache' }));
  serveClient(app);
  app.get('/favicon.ico', (c) => c.body(null, 204));
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
