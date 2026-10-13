# Review craft: what makes a review worth reading

The tool gives you a lot of freedom. This is how to spend it. For the building blocks named here see
`authoring.md`.

## Who you are writing for

An engineer reviewing at speed, who acts on the change themselves. The page exists so they
**understand the change fast and stay connected to the real code** while doing so. Whenever the
narrative says something, their next thought is "what does that look like in the code? what was
there before? what changed?" Answer that before they ask, by linking every claim.

## The first sixty seconds

The opening carries most of the value:

1. **One paragraph** saying what the change does and why (`<p class="rr-lede">`).
2. **One diagram of the delta in context** (`<rr-flow>`): the surrounding flow as `baseline` nodes,
   the change as `new` / `changed` / `removed`, every node clickable. Put pure background in
   `data-baseline` blocks so it stays out of the way.
3. **A short paragraph** that walks the diagram, linking the two or three hunks that hold most of the
   change.

Someone who reads only this should know where to look and what to worry about.

## The body

- Sections in the order a reviewer traces the change: entry point → new code → storage / proto /
  config → failure modes → tests → risks. Each is a `<section id>` with an `<h2>`, short and about
  one concern, so it can be commented on as a unit.
- For a big change, add a "Reading order" section near the top: a numbered list of links into
  sections and hunks, top-down from the entry point or bottom-up from the leaf changes.
- Every factual claim about the code carries a link. Point at code rather than describing it.
- Say what changed **and what was there before** when that's the interesting part (link `@base`).
- Call out real risks with `<rr-callout kind="risk">`, not every observation. Say what is *not*
  tested.
- End with an `<rr-checklist>` of the decisions that need a human sign-off (compatibility, latency,
  migrations, observability, rollout).
- Interpret the PR description and connect it to the code; don't restate it.
- Keep the structure the same across reviews. Don't over-build.

## When to build something interactive

Use HTML, SVG or script when a picture or a widget answers a question faster than prose: a latency
budget, a state machine, the shape of rows in a table, a query plan, a before/after of a data
structure. Make widget parts clickable into the code with `rr.open(…)`.

## Answering threads

Never repeat the same content across narrative, reply and thread:

- Short answers go in the reply.
- Substantial answers (tables, diagrams, queries, sketches, a visualisation the reviewer asked for)
  become a new section marked `data-round="<next round>"`; the reply links to it or embeds it.
- Refer to code with links or embeds rather than quoting it.
- When the answer is already in the narrative, link that section instead of re-explaining it.
