---
status: accepted
---

# A phone reaches reviewroom through the hub, at one configured public origin

An installed PWA is bound to one origin forever (manifest `scope` and `start_url`, the service worker, storage), and
service workers only run on an HTTPS origin the phone trusts. Today every review is its own origin
(`http://127.0.0.1:<4848+>`), and `allowed()` in `cli/lib/server.ts` answers only `127.0.0.1` and `localhost`.

**Decision:** the **hub** (127.0.0.1:4847, one per machine) is the only origin a phone sees. It serves its page at `/`
and the **hub proxy** forwards `/r/<review id>/...` to that review's server on `127.0.0.1:<port>`. How a phone reaches
the hub is outside reviewroom, as in Collie: the servers bind loopback, the reviewer puts a front in front of the hub
(tailscale serve, a tunnel, anything that ends in HTTPS) and tells the hub its **public origin**. One client build works
under any path prefix.

```
phone --https--> [front: not reviewroom] --http--> hub 127.0.0.1:4847 --/r/<id>/*--> review 127.0.0.1:4848..
                  tailscale serve, tunnel           hubAccess(c): loopback       Host, Origin rewritten
                                                    or the public origin         to the review's loopback
```

## Decision

1. **Origin.** The hub. A review lives at `/r/<id>/`, where `<id>` is the first 12 hex digits of sha1 of the review
   dir: stable across rounds, restarts and port changes (a `reviewroom:<pid>` session id is not). `/r/<id>` redirects
   to `/r/<id>/`. The proxy only forwards to ports of live reviewroom sessions in the hub's registry. Manifest `scope`
   and `start_url` are `./` at the hub root; the service worker is `/sw.js` with scope `/`.
2. **HTTPS and connectivity.** Not reviewroom's job. No Tailscale code, no tunnel management, no pairing. Nothing binds
   anything but `127.0.0.1`.
   *Later:* an optional setup script (`bun run setup-phone`, `scripts/phone-setup.ts`) runs the Tailscale and portless
   commands for the reviewer; the CLI and servers still carry no Tailscale code. The hub also admits the portless name
   `https://reviewroom.localhost:1355` (hard-coded, a personal setup).
3. **Access: one seam.** A hub-only middleware, `hubAccess(c)` in `cli/hub/`, decides who may use the hub and its
   proxy. Today it accepts:
   - loopback, exactly as `allowed()` does now;
   - the configured public origin: `Host` equal to its host, and on `/api/` and `/r/*/api/` the same cross-site checks
     (`Sec-Fetch-Site` same-origin or none; on writes, `Origin` absent or equal to the public origin).

   Identity is added here later and nowhere else: a `Tailscale-User-Login` allowlist (tailscale serve deletes incoming
   identity headers and sets its own), a Cloudflare Access JWT, or a pairing cookie. After `hubAccess` passes, the proxy
   rewrites `Host` and `Origin` to the review server's loopback values. Review servers keep `localOnly` unchanged
   (loopback only); on proxied requests they re-check only Host and the passed-through `Sec-Fetch-Site`.
4. **Client paths.** Relative everywhere, so one build serves `/` and `/r/<id>/` (table below). `page()` serves the
   entry as relative `_rr/reviewroom.js`, so each review page loads its own server's build through the proxy.

## Security model

The review API writes `state.json`, posts to GitHub as the `gh` user, and its feedback is read by a coding agent with a
shell: a forged write is a prompt injection into that agent.

| Attacker | Result |
| --- | --- |
| Website in the reviewer's browser (form POST, `no-cors`) | blocked: Origin and Sec-Fetch-Site; the public origin is the only extra allowed Origin |
| DNS rebinding (`evil.com` -> 127.0.0.1) | blocked: Host must be loopback or exactly the public host |
| Local process on the machine | full access, as today |
| Anyone the front lets reach the hub | **full access.** No identity check in this version: the front is the access control |
| Script in one review's agent-written HTML | can call the hub and every other review: they share one origin |

Known consequences, accepted for now:
- Whoever can reach the public origin can read every running review and write to it. Front it only with something
  that admits just the reviewer (a personal tailnet with tailscale serve, not Funnel; a tunnel with an access policy).
  The identity check is a later addition to `hubAccess`.
- One origin removes the isolation between reviews. Agent-written HTML was already trusted in the reviewer's page; that
  trust now covers every running review and the hub's close-session action.

## Considered options

- *One fixed port per review* (each its own HTTPS origin): every review becomes its own installed app, ports drift
  (`listen()` takes the next free one), and each needs its own front. Rejected.
- *Subdomain per review*: needs wildcard certificates the common fronts (`ts.net`) don't give. Rejected.
- *LAN with a self-signed certificate*: browsers refuse to register a service worker on a page with a certificate
  error, so the PWA cannot install or update; trusting a local CA is per-device fiddly. Not supported (a front that
  does it is still the reviewer's business).
- *reviewroom runs the front* (`hub --tailscale`, QR pairing, login allowlist): deferred, not rejected. It plugs into
  `hubAccess` and the config key below without moving the origin.

## What breaks under `/r/<id>/` (the work of rr-o9x.2)

| Where | Today | Fix |
| --- | --- | --- |
| `src/kernel/providers/server-state.ts`, `src/review/providers/local.ts` (`'/api'` defaults, 3), `src/main.ts` (`api` attr default, 2) | absolute `/api` | relative `api` (works at `/` and `/r/<id>/`; prototyped) |
| `src/kernel/header.ts`, `src/main.ts`: All reviews -> `/api/hub` | review server redirects to `http://127.0.0.1:4847/` | under `/r/`, link `/` (the hub, same origin) |
| `templates/review.html` and every agent `review.html`: `/_rr/reviewroom.js` | absolute: under the proxy it would load the hub's build | `page()` rewrites that one `src` to `_rr/reviewroom.js`; the entry name stays |
| Root-absolute asset paths in agent HTML (`src="/diagram.svg"`) | work | break (none in examples). Skill: use relative paths; `reviewroom check` can flag them |
| Lazy chunks, fonts, emoji data | `import.meta.url`-relative | fine |
| Hub page links (`session.url` = `http://127.0.0.1:<port>/`) | loopback | on the public origin link `/r/<id>/`; on loopback keep per-port URLs (the macOS app keys tabs by port) |
| SSE `/api/events` | direct | streams through a `fetch` passthrough (prototyped); 20 s pings keep both hops open |
| `localStorage` `reviewroom:prefs`, `:layouts`, `:github-token` | per port | shared by all reviews (what prefs and saved layouts should have been) |
| `localStorage` keyed by `meta.id` (`draft:`, `recap:`, `layout:`, `state:`) | per port and id | per id only; `meta.id` is `repo#number#title`, so key by the review id instead |
| Hub port | drifts to 4848+ if 4847 is taken | with a public origin set, bind 4847 or fail: the front points at a fixed port |

## Configuration

One key: `publicOrigin` in `~/.reviewroom/config.json`, set by `reviewroom hub --public-origin <url>` and cleared with
`--public-origin none`. A file, not only a flag, because the hub is usually started by `ensureHub()` from a review's
All reviews button. The hub prints the public URL next to the loopback one. The flag goes into `reviewroom --help` and
`config.json` into the `~/.reviewroom/` contract in AGENTS.md. Later identity settings go next to it in the same file.

## Consequences

- **rr-o9x.2** implements the proxy, `hubAccess`, relative paths, the review id in the hub snapshot, the config key and
  the e2e cases (foreign Host, foreign Origin, unknown id, SSE through the proxy). The proxy caches the id-to-port map
  rather than polling every session per request.
- **rr-o9x.4**: worker at `/sw.js`, scope `/`; never intercept `/api/*` or `/r/*/api/*`. A review page's client is
  `/r/<id>/_rr/*`, so precaching the hub's `/_rr/` warms the hub only; review chunks are cached at runtime.
- **rr-o9x.6**: one manifest at the hub root, `/manifest.webmanifest`, `scope`/`start_url` `./`; review pages link it
  by that absolute path. The installed app opens on the hub. No cookie, so no `crossorigin` on the link.
- **rr-8qy.7**: phones open the public origin (or loopback with `?phone`); `/r/<id>/` URLs are what to share.
- The public origin can never change once installed; picking it is the reviewer's one-time decision.

## Prototype

Commit e228293 on `abhirup/rr-o9x.1-phone-origin` ("prototype, not for merge"): the `/r/<id>/*` route in
`cli/hub/server.ts` (Hono route plus `fetch` passthrough), relative `api` in the client, and an env var for the public
origin. On the demo review: the page loads at `/r/<id>/` and the client calls `meta`, `state`, `files`, `patch`, `read`
and `github` through the proxy; a POST with the public Host and Origin applies an op and a `state` event arrives on an
event stream opened through the proxy; a foreign Host or a foreign Origin on a POST gets 403. Not checked: a real front,
a real phone, upstream abort when the phone disconnects.
