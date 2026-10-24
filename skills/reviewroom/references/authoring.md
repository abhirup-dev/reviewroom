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
extra assets (images, js, css) next to `review.html` and reference them relatively (`diagram.svg`, never
`/diagram.svg`: the hub also serves the review under `/r/<id>/`). Leave `<rr-app>`'s `api` unset.

`#rr-meta` is optional JSON; leave it `{}` unless you need it. The CLI supplies the repo, PR and
revisions. `"title"` replaces the review's title. `"theme"` overrides colour tokens per mode, without the
`--rr-` prefix: `{ "theme": { "light": { "accent": "#7a3cff" }, "dark": { … } } }`.

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
| `rr:code/pkg/x.go#L45-54` | Lines 45–54 of any file in the repo at the head revision |
| `rr:code/pkg/x.go@base#L45` | The same file at the base (`@<sha>` for any other commit) |
| `rr:code/pkg/x.go` | The whole file; for a file in the diff its preview shows the changed hunks |
| `rr:sym/RecentEvents` | A symbol, found by searching the repo (definition first); its preview shows the whole declaration |
| `rr:sym/Builder.Build` | A symbol narrowed by its receiver, type or package (`habit.RecentEvents`) |
| `rr:sym/pkg/ranker/builder.go:Build` | A symbol narrowed by its file (also a path suffix: `ranker/builder.go:Build`) |
| `rr:doc/request-path` | A section or element id in the walkthrough |
| `rr:doc/request-path/<block>` | A block inside it, as feedback anchors give it; copy it from there, don't write it by hand |
| `rr:thread/t_ab12cd` | An agent thread (`gh_<n>`: a team thread on the PR) |
| `rr:round/2` | The walkthrough as it was at the end of round 2 |
| `rr:tour/latency/s3` | A guided walkthrough slide; `<rr-embed>` shows it as a slide card (its text, its code, a play button) |

A file in the diff opens in the diff view; any other file opens whole. (`rr:file/<path>@<rev>` is the
older spelling and still works.) Line numbers are the **head** revision's unless you add `@base`. The head is a sha from
`reviewroom status --json`, not your checkout: verify with `git show <head>:<path> | sed -n '45,54p'`.

Hovering any link shows a live preview of its target; clicking it opens the target in the code or
walkthrough panel. Never show the raw `rr:` string.

Two ways to write a link:

- `<rr-ref ref="rr:…"></rr-ref>`: a chip. **Leave it empty** and it labels itself (`fetcher.go:21`,
  a symbol's name, a section's heading). This is the default.
- `<a href="rr:…">the retry loop</a>`: when the link text is a phrase in your sentence. Link a thing
where it first comes up, not on every mention: within the next few paragraphs, plain text is fine.

## Symbols

Prefer `rr:sym/<name>` for a function or type: it follows the code as it moves, and `check` never
reports it as moved. A bare name that has several definitions (`Build`, `New`) is ambiguous: clicking
it opens a search instead of jumping. Qualify it (`Builder.Build`, `ranker/builder.go:Build`) whenever
the name isn't unique in the repo. A method declared inside a class body (TypeScript, Python) only
narrows by file, so use the `path:Name` form there; `check` reports a qualified link that matches nothing as broken.

When a link's text is exactly the identifier declared at its target (`<a href="rr:sym/BuildRequest">BuildRequest</a>`,
or a `rr:code` range that starts at the declaration or its doc comment), the link renders as code
with a kind badge (function, method, struct, interface, type…). Use plain prose for links that point
at behaviour rather than a declaration ("the retry loop").

## Code previews

Never paste diff code into the page; it goes stale and duplicates the code panel. Instead:

```html
<rr-ref ref="rr:code/pkg/ranker/request_builder.go#L50-54"></rr-ref>                <!-- chip; hover = preview -->
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

Pictures are first-class, in three forms, and you choose by the question (the menu, with snippets per
question and the presets, is `visual-formats.md`): Mermaid in `<rr-mermaid>` for anything with nodes and
edges, `<rr-flow>` for a short linear delta with badges, and your own HTML, SVG or table for a shape
neither has. Mermaid is the cheapest, not mandatory: when the picture isn't a graph, draw what it is.

```html
<rr-mermaid id="request-path" class="rr-diagram-delta">             <!-- Mermaid source, HTML-escaped (&lt; &gt; &amp;) -->
flowchart TD
  Req[FeedRequest] --> Fetch[habit.RecentEvents, new]:::added --> Rank[RankerRequest, changed]:::changed
  click Fetch "rr:code/pkg/features/habit/fetcher.go#L20-28" "the fetcher"   <!-- click-to-code, any rr: link -->
</rr-mermaid>
```

Reviewroom renders it with Pele (Mermaid 12 syntax: flowchart, sequence, state, class, treeView, timeline,
gitGraph, sankey, architecture, C4 and more), fitted to the panel width, in reviewroom's theme.
Fenced ```` ```mermaid ```` blocks in Markdown (`<rr-markdown>`, thread replies, the PR description) render the
same way. A `click` statement with an `rr:` address opens the code; JavaScript callbacks, images and HTML labels
are not supported. One class picks a preset (`rr-diagram-delta`, `-baseline`, `-soft`, `-blueprint`, `-warm`,
`-square`, `-raised`, `-signal`; see `visual-formats.md`); don't hard-code colours, they break the theme switch.
Give it an `id` so threads can anchor on it. Pele has no animation; the guided walkthrough lights nodes for you.

```html
<rr-flow direction="column">                                                           <!-- top→bottom; omit for left→right -->
  <rr-node state="baseline">FeedRequest</rr-node>
  <rr-node state="new" ref="rr:code/pkg/features/habit/fetcher.go#L20-28">habit.RecentEvents</rr-node>
  <rr-node state="changed">RankerRequest</rr-node>                                     <!-- new changed removed baseline -->
</rr-flow>
<rr-callout kind="risk" title="Silent degradation">…</rr-callout>                      <!-- info note risk question ok -->
<rr-checklist><rr-check id="proto-compat">Proto change is append-only</rr-check></rr-checklist>  <!-- open questions -->
<rr-markdown>## Markdown blocks work too</rr-markdown>
```

`<rr-flow>` is the hand-built form of the delta diagram every walkthrough has: a short chain of states.
Give every node a `ref` so it is clickable. The panel is narrow (see "Design for a narrow column" in
`review-craft.md`): a left-to-right flow of more than three nodes wraps and its arrows stop lining up,
so use `direction="column"` for it (Mermaid: `flowchart TD`).

Each `<rr-check>` is one **open question**; the reviewer marks it settled or not, and the feedback
lists them under `Open questions` by `id`. Always give it an `id`: without one, the first 40
characters of its text stand in, and rewording it loses the reviewer's mark.

## Scripting: `window.rr`

Use only the functions documented below: `rr.app` is reviewroom's internal state and may change between versions.

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
| `rr.walkthrough(chapter?, step?)` | Play the guided walkthrough (ids; none: from the start) |
| `rr.findSymbol(name)` | Jump to a definition (same name forms as `rr:sym`) |
| `rr.read(path, 'head' \| 'base' \| sha)` | File contents (string) |
| `rr.files()` / `rr.search(q, symbol?)` | Changed files / repo search hits |
| `rr.comment(ref, body?)` | Open the composer on (or create) a thread |
| `rr.on(event, fn)` | `state`, `theme`, `active-section`, `active-file`, `selection`… |
| `rr.commands.register({ id, title, keys, run })` | Add palette commands / shortcuts |
| `rr.definePanel({ id, title, create })` + `rr.addPanel(id)` | Add a whole dockable panel |
| `rr.layout('reading' \| 'wide-code' \| 'code-focus' \| 'narrative-focus' \| 'tablet' \| <saved name>)` | Switch layout (false if there's no such layout) |
| `rr.theme()` | `'light'` or `'dark'` |

## Guided walkthrough: `walkthrough.json`

The optional guided walkthrough of the diff, played over the workbench: chapters of slides (`steps`), narration
on the left, the slide's code on the right, moved through with ← →. It sits next to `review.html` in the
review directory and is validated against `schema/walkthrough.schema.json` in the reviewroom install (`reviewroom check
--help` prints its absolute path). Put that path in a top-level `"$schema"` key so your editor validates as you type.
The demo has a full one: `examples/habit-events/walkthrough.json`.

```json
{
  "version": 1,
  "title": "Attach recent HABIT events to the ranker request",
  "chapters": [
    {
      "id": "why",
      "title": "Why this change",
      "lead": "<p class=\"rr-lede\">…</p><rr-flow>…</rr-flow>",
      "steps": [
        { "id": "s1", "text": "<p>Before this PR, <a href=\"rr:sym/Build\">Builder.Build</a> …</p>", "ref": "rr:code/pkg/ranker/request_builder.go@base#L29-39" },
        { "id": "s2", "text": "<p>A TFS error comes back wrapped (top); the builder degrades (below).</p>", "ref": ["rr:code/pkg/features/habit/fetcher.go#L23-26", "rr:code/pkg/ranker/request_builder.go#L50-54"] },
        { "id": "s3", "text": "<p>That is the whole path.</p>" }
      ]
    }
  ]
}
```

| Field | |
|---|---|
| chapter `id`, step `id` | Lowercase letters, digits, dashes; unique (steps: within their chapter). Threads anchor on them, so keep them when you reorder |
| `lead` | HTML that stays on screen for the whole chapter: a lede, an `<rr-mermaid>` or `<rr-flow>` |
| step `text` | HTML for this slide; it changes from slide to slide, the lead does not |
| step `ref` | What the right pane shows: one `rr:code/`, `rr:file/`, `rr:sym/` or `rr:doc/` link (its whole file, the lines highlighted), or a list of them (each chunk stacked, across files) |
| no `ref` | The pane keeps the chapter's last links; with none yet, the previous chapter's. The lead's diagram stays in the lead, next to the slide |
| step `focus` | Labels of the diagram nodes (`<rr-node>` text, or a Mermaid node's label, in the lead or the slide's text; a timeline's or gitGraph's nodes have none) that light up on this slide, as written; the rest dim, and the edges between lit nodes of a Mermaid flowchart or class diagram flow. Omitted: nodes whose `ref` (a `click` link, for Mermaid) overlaps the code the pane shows light up; `[]` lights none. `check` flags a label no node has |

Prose is HTML like the walkthrough's, with the same links, `<rr-ref>`, `<rr-code>`, `<rr-mermaid>` and `<rr-flow>`; a code
link in the text shows that code in the pane without leaving the slide. It is display-only, since a guided walkthrough can come
from a PR: text, http(s) and `rr:` links, `<rr-ref>`, `<rr-code>`, `<rr-mermaid>` (with its preset `class`), `<rr-flow>`, `<rr-callout>`,
`<rr-embed>`; ids, styles, scripts, forms, media and `<rr-check>` are stripped (`slide-lint` names what was). A figure
that needs more than that (your own HTML or SVG) lives in `review.html` and comes in as `<rr-embed ref="rr:doc/<id>">`. One concept per chapter; the shape is in `guided-walkthrough-craft.md`.

- `reviewroom check` validates the file first, then every link in it, then whether it works as a guided walkthrough
  (changed files no slide shows, chapter sizes); problems name the slide (chapter/step). A file linked
  anywhere in slide text counts as shown; tests, generated, dependency, lock and doc files, and files with under 10 changed lines,
  are only reported as info.
- Highlight budget at a laptop screen: about 25 lines for one ref, 10 each for two stacked, never more than two
  stacked. `check` estimates it; `slide-lint` measures it and proposes a narrower range.
- `reviewroom slide-lint` plays every slide in a headless browser and reports what does not fit:
  narration that needs scrolling, highlighted lines off screen, stacked chunks too short, content wider
  than its box, prose the sanitizer strips, page errors. Each finding says how to fix it.
- `reviewroom shot <chapter>/<step>` renders one slide to a PNG (`--theme dark`, `--viewport`).
- `rr.walkthrough(chapter?, step?)` plays it from a script; `rr:tour/<chapter>/<step>` links to a slide,
  and `<rr-embed ref="rr:tour/<chapter>/<step>">` puts the slide in the walkthrough.
- `reviewroom publish-slides` posts it to the PR as a ```` ```reviewroom-walkthrough ```` block in a
  comment (updated in place on the next publish); `reviewroom pr <n>` pulls it on another machine.

## Typography and colour

The tool sets both; don't load fonts or hard-code colours. Headings, lists, tables, code and callouts
inside `<rr-review>` are already styled: write plain semantic HTML. In your own widgets use the tokens:

- Fonts: `--rr-font-read` (prose), `--rr-font` (labels, legends, table headers), `--rr-mono` (code, identifiers, numbers).
- Sizes: `--rr-text-prose`, `--rr-text`, `--rr-text-sm`, `--rr-text-xs`.
- Colours: `--rr-ink`, `--rr-muted`, `--rr-line`, `--rr-surface-doc-2` (figure background), `--rr-accent` (links only), `--rr-add`, `--rr-del`, `--rr-comment`.

They switch with light and dark mode, so widgets built on them follow the theme.

Size widgets to their container, not the window: no fixed pixel widths, `max-width: 100%`, an SVG
with a `viewBox` and `width="100%"` (no fixed `width`), and stack rather than sit side by side. Check
they read at about 360px wide.
