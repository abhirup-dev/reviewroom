# Review craft: what makes a reviewroom review worth reading

These are the reviewer's stated preferences, distilled from designing the tool with them. Treat them
as the brief. The tool gives you a lot of freedom; this is how to spend it.

## Who you are writing for

An engineer reviewing at high velocity, usually PRs larger than five files with one or two commits,
mostly on a large monitor (sometimes a laptop). They act on the review in GitHub themselves; the
page exists so they **understand the change fast and stay connected to the real code** while doing
so. Whenever the narrative says something, their next thought is "what does that look like in the
code? what was there before? what changed?" Answer that before they ask by linking every claim.

## The first sixty seconds

The opening of the page carries most of the value:

1. **One paragraph** saying what the change does and why (`<p class="rr-lede">`).
2. **One diagram of the delta in context**: the surrounding flow as `state="baseline"` nodes and the
   change as `new` / `changed` / `removed`, every node clickable (`<rr-flow>` with `ref`s). The
   baseline matters but must stay out of the way: put pure background in `data-baseline` blocks,
   which are set apart visually from the change.
3. A short paragraph of prose that walks the diagram, linking the two or three hunks that hold most
   of the change.

If someone reads only this, they should know where to look and what to worry about.

## The body

- Sections in the order a reviewer traces the change: entry point → new code → storage / proto /
  config → failure modes → tests → risks. Each a `<section id>` with an `<h2>`, short enough to
  comment on as a unit.
- Every factual claim about the code carries a link (`rr:code/…#L`, `rr:sym/…`). Prefer pointing at
  code to describing it; use `<rr-code ref>` when the reader needs to see lines inline. Never paste
  diff code into the page: it goes stale and duplicates what the code panel shows.
- Say what changed **and what was there before** when that's the interesting part (link `@base`).
- Call out real risks with `<rr-callout kind="risk">`, not every observation. Say what is *not*
  tested.
- End with an `<rr-checklist>` of the decisions that need a human sign-off (compatibility, latency,
  migrations, observability, rollout). The reviewer uses it as their risk sign-off.
- Keep the narrative simple and consistent across reviews. Don't over-build; the structure above is
  the house style.

## Freedom: when to build something interactive

You may write any HTML, CSS, SVG or script. Use it when a picture or a widget answers a question
faster than prose: a latency budget, a state machine, the shape of rows in a table, a query plan, a
before/after of a data structure. Make widget parts clickable into the code with `rr.open(…)`.
When the reviewer asks for a visualisation in a thread ("show me what this table looks like with
some rows and the queries"), build it as a new section and link it from your reply.

## Answering comments: no duplication

The reviewer dislikes the same content repeated across narrative, comment and thread. So:

- Short answers go in the reply.
- Substantial answers become a new section (`data-round="<next round>"`), and the reply links to it
  or embeds a live preview (`![](rr:doc/<id>)` on its own line).
- Refer to code with links or embeds (`![](rr:code/…#L10-20)`) rather than quoting it.
- When something they asked about is already in the narrative, link that section instead of
  re-explaining it.
- Use durable links freely: they render as chips and previews, and are how the reviewer navigates.

## Guided order

The reviewer likes a step-by-step path through a change (top-down from the entry point, or bottom-up
from the leaf changes). The UI has no dedicated tour mode yet, so make the section order itself the
path, and for big changes add a short "Reading order" section near the top: a numbered list of links
into sections and hunks.

## Things to avoid

- Raw identifiers, CSS paths or `rr:` strings in visible text: give links human labels.
- Long walls of prose, and sections that mix several concerns (hard to comment on precisely).
- Claims without links, wrong line numbers, and code pasted from the diff.
- Restating the PR description: interpret it, connect it to the code.
