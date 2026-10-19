# Guided walkthrough craft: a story, not a tour of files

How to write `walkthrough.json`, the chaptered slides the reviewer plays before the detailed review. The
file format and the commands are in `authoring.md` ("Guided walkthrough"); the long-form walkthrough
(`review.html`) is `review-craft.md`.

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

**Dependency files never get a slide.** `go.mod`, `go.sum`, `package.json`, lockfiles, `requirements.txt`,
`pyproject.toml`, `Cargo.toml`, `pom.xml` and their kin are not part of the story: don't point a `ref` at
them or give them a chapter. A thread that needs a new library says so in a sentence on the slide that
uses it. The one exception is a PR that is only a dependency change.

**Pictures.** A slide is a picture with a caption, and the picture is often not code. The context
chapter's lead is an `<rr-flow>` of the surrounding system with the threads marked; the convergence
shows the contract as a diagram (who writes it, who reads it) before it shows the lines; a thread
chapter opens on its flow, then walks it line by line. Slides take `<rr-flow>`, `<rr-code>` and
`<rr-callout>` directly, and `<rr-embed ref="rr:doc/<id>">` for any richer figure you drew in
`review.html`, so draw once and show it in both. Build every figure for the narrow pane.

**A map that stays while the slides walk it.** A chapter that walks several parts of one system
draws the whole system once, as the lead's `<rr-flow>`, with each node's `ref` on its code. The
diagram stays put while ← → move through the slides, and the node each slide is about lights up
(the rest dim): any node whose `ref` overlaps the code the pane shows does so on its own. A slide's
`focus` names the nodes outright when they have no code (a service, a queue, a concept), or to pick
among several. The reader can fold a tall lead away. When the map would crowd every slide, put the
same `<rr-flow>` in each slide's text instead; the same rule lights it there. This is the chapter's
picture, so give each node the name the slides use.

**Anti-patterns**, all from one real walkthrough: chapters named after review categories (Why,
Validation, Failure modes, Tests) instead of parts of the change; slides about what the PR is *not*;
a thread introduced on slide 2 that vanishes until chapter 4; the critical contract spread over four
slides and never named as the centre.

## With the walkthrough (`review.html`)

One story at two depths:

- Outline once, then write both from it. The walkthrough's first sections mirror the chapters, in the
  same order with the same names; its risk, test and open-question sections come after, and the
  reconciliation points at them. A chapter's lead or last slide links its section (`rr:doc/<id>`); a
  section can link back to its slide (`rr:tour/<chapter>/<step>`).
- Tables, supporting detail and caveats go in the walkthrough; a slide carries only the attributed
  number its claim needs. The guided walkthrough is written once and kept stable; the walkthrough grows
  round by round (see "Answering threads" in `review-craft.md`).
- Each slide fits the screen; `reviewroom walkthrough lint` measures it. Split a slide rather than
  squeeze it.
