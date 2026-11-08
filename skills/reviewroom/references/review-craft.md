# Review craft: what makes a walkthrough worth reading

The walkthrough (`review.html`) is the long-form review: every claim linked, risks, tests and the open
questions, growing round by round as threads come in. This is how to write it; the building blocks are
in `authoring.md`, and the guided walkthrough (the story told once, before it) is
`guided-walkthrough-craft.md`.

## Who you are writing for

The reviewer: an engineer reviewing at speed, sometimes the author of the diff. The walkthrough exists
so they **understand the diff fast and stay connected to the real code** while doing so. Whenever the
walkthrough says something, their next thought is "what does that look like in the code? what was
there before? what changed?" Answer that before they ask, by linking every claim.

## The first sixty seconds

The opening carries most of the value:

1. **One paragraph** saying what the diff does and why (`<p class="rr-lede">`).
2. **One diagram of the delta in context**: the surrounding flow, with the diff marked as added /
   changed / removed and every node clickable. `<rr-mermaid class="rr-diagram-delta">`
   (`visual-formats.md`). Put pure background in `data-baseline` blocks
   so it stays out of the way.
3. **A short paragraph** that walks the diagram, linking the two or three hunks that hold most of the
   diff.

Someone who reads only this should know where to look and what to worry about.

## The body

- Sections in the order a reviewer traces the diff: entry point → new code → storage / proto /
  config → failure modes → tests → risks. Each is a `<section id>` with an `<h2>`, short and about
  one concern, so it can be commented on as a unit.
- For a big diff, add a "Reading order" section near the top: a numbered list of links into
  sections and hunks, top-down from the entry point or bottom-up from the leaf changes.
- Every factual claim about the code carries a link. Point at code rather than describing it.
- Say what changed **and what was there before** when that's the interesting part (link `@base`).
- Call out real risks with `<rr-callout kind="risk">`, not every observation. Say what is *not*
  tested.
- End with the open questions (`<rr-checklist>`, one `<rr-check>` each): what the reviewer must settle
  before approving (compatibility, latency, migrations, observability, rollout).
- Interpret the PR description and connect it to the code; don't restate it.
- Don't over-build: a lede, the delta diagram, a handful of sections and one checklist cover a typical
  diff. Let the sections follow the change. Match the review's length and depth to the complexity and
  impact of the change, informed by the code's logic and the PR description. A section is one concern,
  not one file.

## Design for a narrow column

The walkthrough usually sits in a side panel about 400px wide, or on a phone.
Write for that width first; a wide window then just has margin.

- Diagrams run top to bottom: `flowchart TD`, tall SVGs rather than wide ones. Pele refits a Mermaid diagram to the panel; it can't
  reflow a wide one.
- Tables of at most three short columns. Wider comparisons become a list per item, or a table with
  the items as rows.
- No side-by-side layouts. A before/after is two blocks, one under the other.
- Long identifiers and paths go in links or chips, not in table cells or diagram nodes.

## Show it, then say it

For sections with moving parts, choose the form that makes the relationships easiest to follow.
A diagram with a short explanation often helps; grouped text is fine when it communicates them
clearly. The lede's delta diagram can be followed by other visuals where they help. `visual-formats.md`
matches questions to pictures: Mermaid (`<rr-mermaid>`) for graphs, sequences, states, trees and
timelines, and your own HTML, SVG or `<table>` when the shape is
something else (a byte layout, a grid of cases, a before/after of a structure). Mermaid is the
quickest, not a requirement. Make the parts clickable into the code (`click` in Mermaid,
`rr.open(…)` in widgets), and build each one for a narrow column.

## Formatting prose

The reviewer scans before they read. Before handing over, read each section as text in the
narrow column and reshape what resists scanning. These four patterns often make scanning harder.
Each example shows one possible improvement, not a required template. Any shape that keeps the
meaning, the distinctions and the code links is fine: a shorter paragraph, a one-level list, a
heading per group, a three-column table, a diagram, or your own HTML. A list that is really a list (steps of a migration, the open questions)
stays a list.

**One paragraph, several independent ideas.** Each idea the reviewer may want to find, link or
comment on gets its own sentence, item or paragraph.

```html
<p>The fetcher now retries twice, the builder degrades when the fetch fails instead of
returning the error, and the ranker request gains an optional events field that the proto marks
append-only.</p>
```

```html
<ul>
  <li><a href="rr:sym/fetchHabit">fetchHabit</a> retries twice.</li>
  <li><a href="rr:sym/Builder.Build">Builder.Build</a> degrades on a failed fetch instead of returning the error.</li>
  <li><a href="rr:code/proto/ranker.proto#L12">RankerRequest.events</a> is new and append-only.</li>
</ul>
```

**An inventory of items with the same shape.** A long run of similarly structured entries can be
hard to scan. Audit whether grouping, summarising or another presentation exposes the distinctions
more clearly; keep the inventory when individual entries are what the reviewer needs to find.

```html
<ul>
  <li><rr-ref ref="rr:sym/TestFetch_RetriesOnce"></rr-ref><br>Retries after one transient error.</li>
  <li><rr-ref ref="rr:sym/TestFetch_GivesUp"></rr-ref><br>Gives up after the second error.</li>
  <li><rr-ref ref="rr:sym/TestBuild_Degrades"></rr-ref><br>Builds without events when the fetch fails.</li>
  <!-- More entries of the same shape. -->
</ul>
```

```html
<h3>Retry policy</h3>
<p>Two attempts, then give up: <rr-ref ref="rr:sym/TestFetch_RetriesOnce"></rr-ref>,
<rr-ref ref="rr:sym/TestFetch_GivesUp"></rr-ref>.</p>
<h3>Degraded ranking</h3>
<p>The request goes out without events: <rr-ref ref="rr:sym/TestBuild_Degrades"></rr-ref>.</p>
```

A table (behaviour, tests, gap) does the same when every item has the same fields.

**A stretch of prose narrating relationships.** "A calls B, which on error wraps it so that C
degrades, unless D": consider a picture with a caption ("Show it, then say it"), or group the
relationships in text. If drawing them, link the relevant code and explain the important relationship.

```html
<p>Build calls the fetcher, which calls TFS; a TFS error comes back wrapped, the builder catches
it and sends the ranker a request without events, while on success the events are attached before
the request leaves.</p>
```

```html
<rr-mermaid id="fetch-path">
flowchart TD
  Build[Builder.Build] --> Fetch[fetchHabit] --> TFS
  TFS -- error --> Degrade[request without events]
  TFS -- events --> Attach[request with events]
  click Fetch "rr:sym/fetchHabit"
  click Degrade "rr:code/pkg/ranker/request_builder.go#L50-54"
</rr-mermaid>
<p>A TFS error never reaches the ranker: the builder degrades at the marked lines.</p>
```

**Lists nested more than one level deep.** The outer level is usually headings or separate
sections; the leaves are one list, or a table when they all have the same fields.

```html
<ul>
  <li>Storage
    <ul><li>Migration <ul><li>adds events_json</li><li>backfills nothing</li></ul></li></ul>
  </li>
</ul>
```

```html
<h3>Storage</h3>
<p>The migration <a href="rr:code/migrations/004_habit_events.sql#L1-9">adds <code>events_json</code></a>
and backfills nothing.</p>
```

## With a guided walkthrough

When the reviewer wants a guided walkthrough too, read `guided-walkthrough-craft.md` first and outline
the story once: the walkthrough's first sections mirror its chapters, and its risk, test and
open-question sections are what the last slide points at.

## Answering threads

For feedback, replies and round-specific walkthrough updates, follow `review-rounds.md`.
Use `authoring.md` for thread links and embeds.
