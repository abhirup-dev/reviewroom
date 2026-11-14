// The hub's proxies (ADR 0001). Reviews at /r/<id>/ are first-party and served as they are. Crit and Plannotator
// sessions at /crit/<key>/ and /plannotator/<pid>/ assume they own the origin's root (`fetch('/api/...')`, `/assets/...`,
// `location.pathname === '/preview'`), so their HTML and scripts are rewritten to stay under the prefix.
import type { Context, Hono } from 'hono';
import type { Hub } from './hub.ts';

/** Request `path` from the server on 127.0.0.1:`port` with its own loopback Host and Origin (it checks the rest). */
async function upstream(c: Context, port: number, path: string, raw: boolean) {
  const up = `127.0.0.1:${port}`;
  const headers = new Headers(c.req.raw.headers);
  headers.set('host', up);
  if (headers.has('origin')) headers.set('origin', `http://${up}`);
  // raw: pass the body on as encoded (else fetch adds its own Accept-Encoding); otherwise it is decoded to be rewritten
  headers.set('accept-encoding', raw ? (headers.get('accept-encoding') ?? 'identity') : 'identity');
  const search = new URL(c.req.url).search;
  return fetch(`http://${up}${path}${search}`, { method: c.req.method, headers, body: c.req.raw.body, redirect: 'manual', signal: c.req.raw.signal, decompress: !raw });
}

const ROOT_ATTR = /(\s(?:src|href|action|poster)\s*=\s*)(["'])\/(?!\/)/gi;
// `location.pathname` reads, not `x.location.pathname` or assignments
const PATHNAME = /(?<![\w$.])(?:window\.)?location\.pathname\b(?!\s*=(?!=))/g;

/** The path below the prefix wherever the tool reads `location.pathname`. Pure, for tests. */
export const rewriteScript = (text: string, prefix: string) =>
  text.replace(PATHNAME, `(location.pathname.startsWith(${JSON.stringify(prefix + '/')})?location.pathname.slice(${prefix.length}):location.pathname)`);

/** Runs before the tool's own scripts: root-absolute same-origin URLs given to fetch, XHR, EventSource, history and
 *  elements' src/href/action (properties and setAttribute; Crit's preview iframe sends no Referer) get the prefix. */
export const shim = (prefix: string) => `<script>(()=>{const P=${JSON.stringify(prefix)};const fix=(u)=>{try{const x=new URL(String(u),location.href);return x.origin!==location.origin||x.pathname===P||x.pathname.startsWith(P+'/')?u:P+x.pathname+x.search+x.hash}catch{return u}};
const F=window.fetch;window.fetch=function(i,o){if(i instanceof Request){const u=fix(i.url);return F.call(this,u===i.url?i:new Request(u,i),o)}return F.call(this,fix(i),o)};
const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return X.call(this,m,fix(u),...a)};
const E=window.EventSource;if(E)window.EventSource=class extends E{constructor(u,c){super(fix(u),c)}};
for(const k of['pushState','replaceState']){const h=history[k];history[k]=function(s,t,u){return h.call(this,s,t,u==null?u:fix(u))}}
const A=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){return A.call(this,n,/^(src|href|action|poster)$/i.test(n)?fix(v):v)};
for(const C of[HTMLIFrameElement,HTMLScriptElement,HTMLImageElement,HTMLLinkElement,HTMLAnchorElement,HTMLSourceElement,HTMLMediaElement,HTMLFormElement])for(const p of['src','href','action']){const d=Object.getOwnPropertyDescriptor(C.prototype,p);if(d&&d.set)Object.defineProperty(C.prototype,p,{...d,set(v){d.set.call(this,fix(v))}})}})();</script>`;

/** A tool's page: root-absolute attributes and `location.pathname` under the prefix, the shim first in <head>. Pure, for tests. */
export function rewriteHtml(html: string, prefix: string) {
  const out = rewriteScript(html.replace(ROOT_ATTR, `$1$2${prefix}/`), prefix);
  const head = /<head(\s[^>]*)?>/i.exec(out);
  return head ? out.slice(0, head.index + head[0].length) + shim(prefix) + out.slice(head.index + head[0].length) : shim(prefix) + out;
}

/** A root path asked for by a tool's page that the shim could not reach (a CSS url(), an element a script made):
 *  the page's prefix from its Referer, or null. Pure, for tests. */
export function referredPath(referer: string | undefined, path: string) {
  if (!referer) return null;
  try {
    const m = /^\/(crit|plannotator)\/([0-9a-f]{1,64})(?=\/|$)/.exec(new URL(referer).pathname);
    return m ? m[0] + path : null;
  } catch {
    return null;
  }
}

async function rewritten(res: Response, prefix: string) {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding'); // fetch decoded the body
  headers.delete('content-length');
  const loc = headers.get('location');
  if (loc?.startsWith('/') && !loc.startsWith('//')) headers.set('location', prefix + loc);
  const type = headers.get('content-type') ?? '';
  const init = { status: res.status, statusText: res.statusText, headers };
  if (/^text\/html/i.test(type)) return new Response(rewriteHtml(await res.text(), prefix), init);
  if (/javascript|ecmascript/i.test(type)) return new Response(rewriteScript(await res.text(), prefix), init);
  return new Response(res.body, init);
}

export function serveProxy(app: Hono, hub: Hub) {
  // hubAccess passed: the review server gets its own loopback Host and Origin, and checks the rest itself
  app.all('/r/:id{[0-9a-f]{12}}', (c) => c.redirect(c.req.path + '/'));
  app.all('/r/:id{[0-9a-f]{12}}/*', async (c) => {
    const id = c.req.param('id');
    const s = await hub.review(id);
    if (!s?.port) return c.json({ error: 'no running review with that id' }, 404);
    try {
      const res = await upstream(c, s.port, c.req.path.slice(`/r/${id}`.length), true);
      // another process took the port since the last poll: say nothing of what it answered
      if (res.headers.get('x-reviewroom-pid') !== String(s.pid)) return (void res.body?.cancel(), c.json({ error: 'the review server is gone' }, 502));
      // as the review sent it: its cache, pid and build headers, and its encoding (the browser's Accept-Encoding went
      // through, so the client build arrives as the review's Brotli files; the hub's compress() skips encoded bodies)
      return new Response(res.body, res);
    } catch (e) {
      return c.json({ error: `the review server did not answer: ${(e as Error).message}` }, 502);
    }
  });

  app.all('/:tool{crit|plannotator}/:key{[0-9a-f]{1,64}}', (c) => c.redirect(c.req.path + '/'));
  app.all('/:tool{crit|plannotator}/:key{[0-9a-f]{1,64}}/*', async (c) => {
    const tool = c.req.param('tool'), key = c.req.param('key');
    const s = await hub.toolSession(`${tool}:${key}`);
    if (!s?.port) return c.json({ error: `no running ${tool} session with that id` }, 404);
    const prefix = `/${tool}/${key}`;
    try {
      return await rewritten(await upstream(c, s.port, c.req.path.slice(prefix.length), false), prefix);
    } catch (e) {
      return c.json({ error: `the ${tool} server did not answer: ${(e as Error).message}` }, 502);
    }
  });
}
