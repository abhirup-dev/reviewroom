import type { Hono } from 'hono';
import type { Hub } from './hub.ts';

export function serveProxy(app: Hono, hub: Hub) {
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
    headers.set('accept-encoding', 'identity'); // loopback: the review answers plain (fetch adds gzip if unset), the hub server compresses once
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
}
