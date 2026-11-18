# Walkthrough craft: a story, not a tour of files

How to write the walkthrough, the chaptered slides the reviewer plays before the detailed review. The
file format and the commands are in `authoring.md` ("The walkthrough"); the report is
`report-craft.md`.

The walkthrough is read before the detailed review. Its job is
comprehension: the reader should come out knowing what changed, what it touches and why, well enough
to hold it in their head while they review. Keep the story factual. The final **Risks** chapter
summarises the main risks; the findings and their evidence belong in the report.

**Shape.** Introduce, develop, turn, reconcile (kishōtenketsu: contrast, not conflict). Chapters in
this order; how many slides each gets is your call, scaled to the diff. A config change needs a
sentence of context; a new subsystem needs a chapter.

1. **Context.** Bring the reader onto your page before any diff code: what exists today, what the
   PR is for, the threads it will follow and where they meet. Name the critical file here, in one
   sentence. The pane shows only code: code as it was (`@base`), or nothing; a flow of the
   surrounding system goes in the lead.
2. **Threads.** One chapter per independent change (usually two to four), in the order data or
   control flows. Each chapter ends on what the convergence will need from it.
3. **Convergence.** The critical file or files: what reads there, what writes there, the contract
   they share. The longest dwell of the walkthrough. Nominate at least one critical file, and at least
   one per five files the diff changes; say in a sentence why each is the centre. With more than two,
   either give them one chapter together, or give each its own chapter with its own prelude: the
   thread that leads to it, then its changes.
4. **Reconciliation.** Re-read the whole with the threads joined.
5. **Risks.** End with a chapter titled **Risks**. Give each main risk one line, with a severity
   (for example, High, Medium or Low) and a link to its finding in the report:
   `<a href="rr:doc/finding-retry-loss">High: retries can discard queued work</a>`.
   Keep the explanation, evidence and suggested direction in that finding. If there are no findings,
   say no material risks were found; do not invent one to fill the chapter.

**Evidence.** The diff and the PR description are the only evidence. Numbers, screenshots and
rationale from the description may be used, attributed on the slide ("the description reports 3×
fewer writes"). What you learned anywhere else (review threads, commits, linked PRs, an earlier run of
your own) is never assumed known. It can be background in the context chapter, in your own words,
attributed and linked; it is never evidence for a claim about this PR. Otherwise leave it out. Never
"as we saw", "the earlier version", "the fix", "a future integration".

**Every slide about code.** First sentence the claim, second the evidence on screen, an optional
third the "therefore" or "but" into the next slide. Every noun is on screen now or was set up by an earlier
slide. When a slide touches something a later chapter explains, say so with a link, so the
question waits: "<a href="rr:tour/convergence/s1">chapter 3</a> shows why this cache exists". If "and then" fits between two slides, they are a list: reorder or cut. Present tense, the code
as subject, verbs that move data or control (reads, writes, calls, guards, drops), not "updates",
"refactors", "improves". Introduce a file by its role, then its name, once.

**Dependency files never get a slide.** `go.mod`, `go.sum`, `package.json`, lockfiles, `requirements.txt`,
`pyproject.toml`, `Cargo.toml`, `pom.xml` and their kin are not part of the story: don't point a `ref` at
them or give them a chapter. A thread that needs a new library says so in a sentence on the slide that
uses it. The one exception is a PR that is only a dependency change.

**Pictures.** A slide is a picture with a caption, and the picture is often not code. The context
chapter's lead is a diagram of the surrounding system with the threads marked; the convergence
shows the contract as a diagram (who writes it, who reads it) before it shows the lines; a thread
chapter opens on its flow, then walks it line by line. Slides take `<rr-mermaid>`, `<rr-code>` and
`<rr-callout>` directly, and `<rr-embed ref="rr:doc/<id>">` for any richer figure you drew in
the report. During the initial slide pass, keep figures in the slides so they do not depend on
unwritten detail. `visual-formats.md` has the menu. Build every figure for the narrow pane.

**A map that stays while the slides walk it.** A chapter that walks several parts of one system
draws the whole system once, as the lead's `<rr-mermaid>`, with each node linked to
its code (a `click` statement). The diagram stays put while ← → move through
the slides, and the node each slide is about lights up (the rest dim, and in a flowchart the edges
between lit nodes flow): any node whose link overlaps the code the pane shows does so on its own. A slide's `focus`
names the nodes outright, by label, when they have no code (a service, a queue, a concept), or to pick
among several. The reader can fold a tall lead away. When the map would crowd every slide, put the
same diagram in each slide's text instead; the same rule lights it there. This is the chapter's
picture, so give each node the name the slides use.

**Anti-patterns**, all from one real walkthrough: story chapters named after review categories (Why,
Validation, Failure modes, Tests) instead of parts of the change (the final Risks chapter is deliberate);
slides about what the PR is *not*;
a thread introduced on slide 2 that vanishes until chapter 4; the critical contract spread over four
slides and never named as the centre.

## With the report

The walkthrough is the story, pinned to the reviewed snapshot. The report is the record:
findings, evidence, flagged questions and later answers. They need not share section names or order.

- Keep detailed findings, tables and caveats in the report. Link them from the slides with
  `rr:doc/<id>`; the report can link back with `rr:tour/<chapter>/<step>`.
- Keep the walkthrough stable while the report grows round by round (see
  "Answer each thread" in `review-rounds.md`). Regenerate it when the reviewed code moves.
- Each slide fits the screen ([Validation and audit](validation-and-audit.md) measures it). Split a slide
  rather than squeeze it.

If the PR ships a walkthrough pulled by `reviewroom pr`, use it as is. Do not replace it to
match this shape. Write the report for the reviewer alongside it.
