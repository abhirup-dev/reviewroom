# Authoring reference: the walkthrough

The building blocks of the walkthrough, `review.html`. For what to write and in what order see `review-craft.md`.

## The file

`reviewroom pr` scaffolds `review.html` in the review directory. It is ordinary HTML:

```html
<rr-app>
  <script type="application/json" id="rr-meta">{}</script>
  <rr-review>
    … anything you want …
  </rr-review>
</rr-app>
```

Inside `<rr-review>` you may write any HTML, inline `<style>`, SVG, `<canvas>` or `<script>`. Put
extra assets (images, js, css) next to `review.html` and reference them relatively.

## Structure the tooling understands

| You write | You get |
|---|---|
| `<section id="request-path"><h2>Request path</h2>…</section>` | Contents entry, scroll-spy, `rr:doc/request-path` links, section-level comments |
| `<section … data-round="2">` | "new in R2" marker (use the round you are writing for) |
| `data-baseline` on any block | "what already exists" context, set apart visually from the diff |
| `id` or `data-rr-block` on any element | A stable, linkable block (the reviewer can comment on anything anyway) |
| `<p class="rr-lede">` | Larger summary paragraph |

## Links: `rr:` refs

Every addressable thing has a durable link. Use them in `<a href>`, `<rr-ref ref>`, `<rr-embed ref>`,
`<rr-code ref>`, `<rr-node ref>`, `rr.open()` and in thread replies.

| Ref | Points at |
|---|---|
| `rr:code/pkg/x.go#L45-54` | Lines 45–54 of the new file in the diff (`@base` for the old side) |
| `rr:code/pkg/x.go` | The file in the diff; its preview shows the changed hunks |
| `rr:file/pkg/y.go@head#L10` | A file **outside** the diff, full view (any rev: `@base`, `@<sha>`) |
| `rr:sym/RecentEvents` | A symbol, found by searching the repo (definition first); its preview shows the whole declaration |
| `rr:doc/request-path` | A section or element id in the walkthrough |
| `rr:doc/request-path/<block>` | A block inside it, as feedback anchors give it; copy it from there, don't write it by hand |
| `rr:thread/t_ab12cd` | An agent thread (`gh_<n>`: a team thread on the PR) |
| `rr:round/2` | The walkthrough as it was at the end of round 2 |

Line numbers are the **head** revision's unless you add `@base`. The head is a sha from
`reviewroom status --json`, not your checkout: verify with `git show <head>:<path> | sed -n '45,54p'`.

Hovering any link shows a live preview of its target; clicking it opens the target in the code or
walkthrough panel. Give every link a human label; never show the raw `rr:` string. Link a thing
where it first comes up, not on every mention: within the next few paragraphs, plain text is fine.

## Symbols

Prefer `rr:sym/<name>` for a function or type: it follows the code as it moves, and `check` never
reports it as moved.

When a link's text is exactly the identifier declared at its target (`<a href="rr:sym/BuildRequest">BuildRequest</a>`,
or a `rr:code` range that starts at the declaration or its doc comment), the link renders as code
with a kind badge (function, method, struct, interface, type…). Use plain prose for links that point
at behaviour rather than a declaration ("the retry loop").

## Code previews

Never paste diff code into the page; it goes stale and duplicates the code panel. Instead:

```html
<rr-ref ref="rr:code/pkg/ranker/request_builder.go#L50-54">Builder.Build</rr-ref>   <!-- chip; hover = preview -->
<rr-code ref="rr:code/migrations/004_habit_events.sql#L1-9" title="table"></rr-code> <!-- live lines, highlighted -->
<rr-embed ref="rr:doc/parallel-sketch"></rr-embed>                                    <!-- preview card of any ref -->
<rr-code lang="go" title="suggested change">…code that is NOT in the diff…</rr-code>   <!-- your own code only -->
```

In thread replies, `![](rr:code/…#L10-20)` or `![](rr:doc/<id>)` on its own line embeds the same
live preview.

## Threads and earlier rounds

Never paraphrase or quote a thread; point at it. The same forms work for agent threads from any
round (`rr:thread/t_…`) and team threads on the PR (`rr:thread/gh_<n>`, `gh_conversation`):

```html
<a href="rr:thread/t_seq01">your question on sequencing</a>          <!-- inline mention: link, hover = preview -->
<rr-embed ref="rr:thread/gh_812"></rr-embed>                         <!-- the thread itself matters: card -->
<a href="rr:round/1">the round 1 version of this section</a>         <!-- what the walkthrough said before -->
```

In a reply: `[your question on sequencing](rr:thread/t_seq01)` inline, or `![](rr:thread/gh_812)` on
its own line for the card. Link when the thread is context; embed when the reader needs its words
next to your answer. A link covers the whole thread, not a single message.

## Diagrams and other helpers

```html
<rr-flow>                                                                              <!-- left→right flow -->
  <rr-node state="baseline">FeedRequest</rr-node>
  <rr-node state="new" ref="rr:code/pkg/features/habit/fetcher.go#L20-28">habit.RecentEvents</rr-node>
  <rr-node state="changed">RankerRequest</rr-node>                                     <!-- new changed removed baseline -->
</rr-flow>
<rr-callout kind="risk" title="Silent degradation">…</rr-callout>                      <!-- info note risk question ok -->
<rr-checklist><rr-check id="proto-compat">Proto change is append-only</rr-check></rr-checklist>  <!-- open question -->
<rr-markdown>## Markdown blocks work too</rr-markdown>
```

`<rr-flow>` is for the one diagram every review should have: the delta against the baseline. Give
every node a `ref` so it is clickable.

## Scripting: `window.rr`

Interactive widgets can drive the reviewer straight into the code:

```html
<script>
  window.addEventListener('reviewroom:ready', ({ detail: rr }) => {
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
| `rr.theme()` | `'light'` or `'dark'` |

## Typography and colour

The tool sets both; don't load fonts or hard-code colours. Headings, lists, tables, code and callouts
inside `<rr-review>` are already styled: write plain semantic HTML. In your own widgets use the tokens:

- Fonts: `--rr-font-read` (prose), `--rr-font` (labels, legends, table headers), `--rr-mono` (code, identifiers, numbers).
- Sizes: `--rr-text-prose`, `--rr-text`, `--rr-text-sm`, `--rr-text-xs`.
- Colours: `--rr-ink`, `--rr-muted`, `--rr-line`, `--rr-surface-doc-2` (figure background), `--rr-accent` (links only), `--rr-add`, `--rr-del`, `--rr-comment`.

They switch with light and dark mode, so widgets built on them follow the theme.
