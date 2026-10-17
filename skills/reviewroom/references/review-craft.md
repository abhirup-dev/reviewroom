# Review craft: what makes a walkthrough worth reading

The tool gives you a lot of freedom. This is how to spend it. For the building blocks named here see
`authoring.md`.

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

## When to build something interactive

Use HTML, SVG or script when a picture or a widget answers a question faster than prose: a latency
budget, a state machine, the shape of rows in a table, a query plan, a before/after of a data
structure. Make widget parts clickable into the code with `rr.open(…)`.

## The guided walkthrough: a story, not a tour of files

The guided walkthrough (`walkthrough.json`) is read before the detailed review. Its job is
comprehension: the reader should come out knowing what changed, what it touches and why, well enough
to hold it in their head while they review. It catches nothing. No evaluation on a slide ("a valuable
fix", "rather than a large abstraction", "not premature"): risks, opinions and comparisons belong in
`review.html`.

**Shape.** Introduce, develop, turn, reconcile (kishōtenketsu: contrast, not conflict). Chapters in
this order; how many slides each gets is your call, scaled to the diff. A config change needs a
sentence of context; a new subsystem needs a chapter.

1. **Context.** Bring the reader onto your page before any diff code: what exists today, what the
   PR is for, the threads it will follow and where they meet. Name the critical file here, in one
   sentence. The pane shows whatever gets that across: a flow of the surrounding system, code as it
   was (`@base`), or nothing.
2. **Threads.** One chapter per independent change (usually two to four), in the order data or
   control flows. Each chapter ends on what the convergence will need from it.
3. **Convergence.** The critical file or files: what reads there, what writes there, the contract
   they share. The longest dwell of the walkthrough. Nominate at least one critical file, and at least
   one per five files the diff changes; say in a sentence why each is the centre. With more than two,
   either give them one chapter together, or give each its own chapter with its own prelude: the
   thread that leads to it, then its changes.
4. **Reconciliation.** Re-read the whole with the threads joined, then point at where to look next:
   the `review.html` sections (risks, tests, open questions) that go deeper. No opinions.

**Evidence.** The diff and the PR description are the only evidence. Numbers, screenshots and
rationale from the description may be used, attributed on the slide ("the description reports 3×
fewer writes"). What you learned anywhere else (review threads, commits, linked PRs, an earlier run of
your own) is never assumed known. It can be background in the context chapter, in your own words,
attributed and linked; it is never evidence for a claim about this PR. Otherwise leave it out. Never
"as we saw", "the earlier version", "the fix", "a future integration".

**Every slide about code.** First sentence the claim, second the evidence on screen, an optional
third the "therefore" or "but" into the next slide. Every noun is on screen now or was set up by an earlier
slide. If "and then" fits between two slides, they are a list: reorder or cut. Present tense, the code
as subject, verbs that move data or control (reads, writes, calls, guards, drops), not "updates",
"refactors", "improves". Introduce a file by its role, then its name, once.

**Anti-patterns**, all from one real walkthrough: chapters named after review categories (Why,
Validation, Failure modes, Tests) instead of parts of the change; slides about what the PR is *not*;
a thread introduced on slide 2 that vanishes until chapter 4; the critical contract spread over four
slides and never named as the centre.

**With `review.html`**, it tells one story at two depths:

- Outline once, then write both from it. The walkthrough's first sections mirror the chapters, in the
  same order with the same names; its risk, test and open-question sections come after, and the
  reconciliation points at them. A chapter's lead or last slide links its section (`rr:doc/<id>`); a
  section can link back to its slide (`rr:tour/<chapter>/<step>`).
- Tables, supporting detail and caveats go in the walkthrough; a slide carries only the attributed
  number its claim needs. The guided walkthrough is written once and kept stable; the walkthrough grows
  round by round (see "Answering threads").
- Each slide fits the screen; `reviewroom walkthrough lint` measures it. Split a slide rather than
  squeeze it.

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
