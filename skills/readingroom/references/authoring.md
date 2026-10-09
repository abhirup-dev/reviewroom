# Authoring reference: the review page

Read this when writing or editing `review.html`. For the CLI and the round loop see `cli.md`;
for what makes a review worth reading see `review-craft.md`.

You are writing the **narrative** half of a code review. The other half — the live diff, file
tree, contents, threads, rounds, palette, theming, docking — is provided by readingroom. Your job
is to explain the change so a fast reviewer understands it, and to link every claim to the code.

## The file

`readingroom pr <n>` scaffolds `<repo>/.readingroom/pr-<n>/review.html`. It is an ordinary HTML file:

```html
<rr-app>
  <script type="application/json" id="rr-meta">{ "number": 4821 }</script>
  <rr-review>
    … anything you want …
  </rr-review>
</rr-app>
```

There are **no restrictions** inside `<rr-review>`: write any HTML, inline `<style>`, SVG, `<canvas>`,
`<script>`, tables, charts. Put extra assets (images, js, css) next to `review.html` and reference
them relatively. **Never paste code from the diff into the narrative** — link to it or use
`<rr-code ref=…>`, which renders the live lines from the repo. The review stays small and never
goes stale.

## Conventions the tooling understands (all optional)

| You write | You get |
|---|---|
| `<section id="request-path"><h2>Request path</h2>…</section>` | Contents entry, scroll-spy, `rr:doc/request-path` links, section-level comments |
| `<section … data-round="2">` | "new in R2" marker after a feedback round (use the round you are writing for) |
| `data-baseline` on any block | "what already exists" context, set apart visually from the change |
| `id` or `data-rr-block` on any element | Stable, linkable, commentable block (reviewers can comment on anything anyway) |
| `<p class="rr-lede">` | Larger summary paragraph |

## Links: `rr:` refs

Every addressable thing has a durable link. Use them in `<a href>`, `<rr-ref ref>`, `<rr-embed ref>`,
`rr.open()`, and in thread replies.

| Ref | Points at |
|---|---|
| `rr:code/pkg/x.go#L45-54` | Lines 45–54 of the new file in the diff (`@base` for the old side) |
| `rr:code/pkg/x.go` | The file in the diff |
| `rr:file/pkg/y.go@head#L10` | A file **outside** the diff, full view (any rev: `@base`, `@<sha>`) |
| `rr:sym/RecentEvents` | A symbol; resolved by searching the repo (definition first) |
| `rr:doc/request-path` | A section/element id in the narrative |
| `rr:thread/t_ab12cd` | A comment thread |

Line numbers are the **new** file's numbers unless you add `@base`. Check them with
`git show HEAD:path | sed -n '45,54p'` before you write them.

**Name symbols exactly.** When a link's text is the identifier declared at its target
(`<a href="rr:code/pkg/x.go#L45-54">BuildRequest</a>`, range starting at the declaration or its doc
comment), the link renders as code with a kind badge (function, method, struct, interface, type…).
Use plain prose for links that point at behaviour rather than a declaration ("the retry loop").

## Helper elements

```html
<rr-ref ref="rr:code/pkg/ranker/request_builder.go#L50-54">Builder.Build</rr-ref>   <!-- chip; hover = preview -->
<rr-embed ref="rr:doc/parallel-sketch"></rr-embed>                                     <!-- mini preview card -->
<rr-code ref="rr:code/migrations/004_habit_events.sql#L1-9" title="table"></rr-code>  <!-- live, highlighted -->
<rr-code lang="go" title="suggested change">…new code that is NOT in the diff…</rr-code>
<rr-flow>                                                                              <!-- left→right flow -->
  <rr-node state="baseline">FeedRequest</rr-node>
  <rr-node state="new" ref="rr:code/pkg/features/habit/fetcher.go#L20-28">habit.RecentEvents</rr-node>
  <rr-node state="changed">RankerRequest</rr-node>                                     <!-- states: new changed removed baseline -->
</rr-flow>
<rr-callout kind="risk" title="Silent degradation">…</rr-callout>                      <!-- info note risk question ok -->
<rr-checklist><rr-check id="proto-compat">Proto change is append-only</rr-check></rr-checklist>  <!-- reviewer sign-off, persisted -->
<rr-markdown>## You can also write markdown blocks</rr-markdown>
```

Use `<rr-flow>` for the one diagram every review should have: the delta against the baseline.
Use `state="baseline"` for what exists, `new`/`changed` for the PR.

## Scripting: `window.rr`

Interactive widgets can drive the reviewer straight into the code:

```html
<script>
  window.addEventListener('readingroom:ready', ({ detail: rr }) => {
    document.querySelector('#bar').onclick = () => rr.open('rr:code/pkg/x.go#L46-49');
  });
</script>
```

| API | |
|---|---|
| `rr.open(ref)` | Navigate to any `rr:` ref |
| `rr.findSymbol(name)` | Jump to a definition |
| `rr.read(path, 'head' \| 'base' \| sha)` | File contents (string) |
| `rr.files()` / `rr.search(q, symbol?)` | Changed files / repo search hits |
| `rr.comment(ref, body?)` | Open the composer on (or create) a thread |
| `rr.on(event, fn)` | `state`, `theme`, `active-section`, `active-file`, `selection`… |
| `rr.commands.register({ id, title, keys, run })` | Add palette commands / shortcuts |
| `rr.definePanel({ id, title, create })` + `rr.addPanel(id)` | Add a whole dockable panel |
| `rr.layout('reading' \| 'wide-code' \| 'code-focus' \| 'narrative-focus')` | Switch layout |
| `rr.theme()` | `'light'` or `'dark'` — read `--rr-*` CSS variables to match colours |

Use the CSS variables (`--rr-ink`, `--rr-muted`, `--rr-line`, `--rr-panel`, `--rr-accent`, `--rr-add`,
`--rr-del`, `--rr-comment`…) in your own styles so widgets follow light/dark.

**Typography is set by the tool; don't load fonts.** Three bundled faces, as tokens:

| Token | Face | For |
|---|---|---|
| `--rr-font-read` | Source Serif 4 | prose: the narrative (the default inside `<rr-review>`) |
| `--rr-font` | Inter | interface-like bits in widgets: labels, legends, table headers |
| `--rr-mono` | JetBrains Mono | code, identifiers, file names, numbers in tables |

Size tokens: `--rr-text-prose` (body), `--rr-text`, `--rr-text-sm`, `--rr-text-xs`. Headings, lists,
tables, code and callouts inside `<rr-review>` are already styled; write plain semantic HTML.

## Theming (optional)

Every colour is a `--rr-*` CSS variable, and each panel sits on its own surface so the reading
pane, the code, the navigation and pop-ups are visibly separate layers:

| Token | Used for |
|---|---|
| `bg` | header bar |
| `surface-doc` / `surface-doc-2` | the narrative (paper) / figures and flows inside it |
| `surface-code` / `surface-well` | code / the area behind file cards |
| `surface-nav` / `surface-nav-2` | Contents, Files, Threads / inputs inside them |
| `surface-bar` / `surface-bar-active` | panel tab bars / the focused panel's bar |
| `surface-overlay` | menus, dialogs, palette, previews |
| `accent`, `comment`, `add`, `del`, `ink`, `muted`, `line` | links (accent is only for links), threads, diff colours, text, rules |
| `sym-fn`, `sym-type`, `sym-value` | kind badges on symbol links |
| `radius-sm`, `radius`, `radius-lg` | near-square by default (2px / 2px / 4px) |

Override any of them per review in `#rr-meta` (light and dark separately; the `--rr-` prefix is optional):

```json
{ "theme": { "light": { "surface-doc": "#fffdf7", "accent": "#0b6bcb" },
             "dark":  { "surface-doc": "#1c1a17", "bg": "#000" } } }
```

Keep text readable on whatever you choose (4.5:1 for body text).

## Writing well

(Expanded in `review-craft.md`.) 
Lead with one paragraph and one `<rr-flow>`. Then sections in the order a reviewer would trace the
change (entry point → new code → storage → failure modes → tests → risks). Every factual claim
about the code gets a link. Prefer short sections the reviewer can comment on individually. Say
what is *not* tested. End with an `<rr-checklist>` of the risks that need a human sign-off.
