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

## The walkthrough and the narrative

When the user wants a walkthrough, it and the narrative tell **one story at two depths**:

- **The walkthrough is the first thing the reviewer sees.** It tells the main story of the change: why,
  the path through the code, what can go wrong. A few chapters, one concept each, 2 to 5 steps each;
  a step says one thing about the code on screen in two or three sentences. It is written once and
  kept stable: the reviewer comes back to it and replays it.
- **The narrative is where they dig in.** The same story in depth: every claim linked, risks,
  tests, the sign-off checklist. It grows round by round as threads come in.
- **Outline once, then write both from it.** Chapters and sections in the same order with the same
  names. A chapter's lead or last step links its section (`rr:doc/<id>`) for the detail; a section can
  link back to its slide (`rr:tour/<chapter>/<step>`).
- **Don't duplicate.** Detail, tables, numbers and caveats go in the narrative, not on a slide.
- **Each slide fits the screen**: no scrolling in the narration, the highlighted lines visible.
  `reviewroom walkthrough lint` measures it; split a step rather than squeeze it.
- **Feedback on a slide grows the narrative.** See "Answering threads".

## Answering threads

Never repeat the same content across narrative, reply and thread:

- Short answers go in the reply.
- Substantial answers (tables, diagrams, queries, sketches, a visualisation the reviewer asked for)
  become a new section marked `data-round="<next round>"`; the reply links to it or embeds it.
- Refer to code with links or embeds rather than quoting it.
- When the answer is already in the narrative, link that section instead of re-explaining it.
- A section written because of a thread links that thread at its top; the reply links the section.
- A thread on a walkthrough step that needs more than a short reply becomes such a section, with the
  slide embedded at its top (`<rr-embed ref="rr:tour/<chapter>/<step>">`): the walkthrough stays as it
  was, and the discussion continues in the narrative.
- When the answer builds on an earlier thread, a GitHub comment or what the narrative said in an
  earlier round, link it rather than restating it.
