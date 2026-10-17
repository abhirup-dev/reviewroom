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
2. **One diagram of the delta in context** (`<rr-flow>`): the surrounding flow as `baseline` nodes,
   the diff as `new` / `changed` / `removed`, every node clickable. Put pure background in
   `data-baseline` blocks so it stays out of the way.
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
- Keep the structure the same across reviews. Don't over-build: for a typical diff, a lede, one flow,
  four to seven sections and one checklist. A section is one concern, not one file.

## Design for a narrow column

The walkthrough usually sits in a side panel about 400px wide, and reviewroom will get a phone view.
Write for that width first; a wide window then just has margin.

- Diagrams run top to bottom: `<rr-flow direction="column">` for more than three nodes, tall SVGs
  rather than wide ones.
- Tables of at most three short columns. Wider comparisons become a list per item, or a table with
  the items as rows.
- No side-by-side layouts. A before/after is two blocks, one under the other.
- Long identifiers and paths go in links or chips, not in table cells or diagram nodes.

## Show it, then say it

Prose explains; a picture lets the reader see. Reach for one by default, not as an exception:
whenever a section has moving parts (a flow, a state machine, a schema, a before/after of a data
structure, a sequence of calls, a latency budget, a query plan), draw it first and write the paragraph
that walks it. The lede's `<rr-flow>` is the first of these, not the only one. Plain HTML and SVG are
enough; a `<table>` is a picture too when the shape of the data is the point. Make the parts clickable
into the code (`ref` on nodes, `rr.open(…)` in widgets), and build each one for a narrow column.

## With a guided walkthrough

When the reviewer wants a guided walkthrough too, read `guided-walkthrough-craft.md` first and outline
the story once: the walkthrough's first sections mirror its chapters, and its risk, test and
open-question sections are what the last slide points at.

## Answering threads

Never repeat the same content across walkthrough, reply and thread:

- Short answers go in the reply.
- Substantial answers (tables, diagrams, queries, sketches, a visualisation the reviewer asked for)
  become a new section marked `data-round="<next round>"`; the reply links to it or embeds it.
- Refer to code with links or embeds rather than quoting it.
- When the answer is already in the walkthrough, link that section instead of re-explaining it.
- A section written because of a thread links that thread at its top; the reply links the section.
- A thread on a guided walkthrough slide that needs more than a short reply becomes such a section,
  with the slide embedded at its top (`<rr-embed ref="rr:tour/<chapter>/<step>">`): the guided
  walkthrough stays as it was, and the discussion continues in the walkthrough.
- When the answer builds on an earlier thread, a team thread or what the walkthrough said in an
  earlier round, link it rather than restating it.
