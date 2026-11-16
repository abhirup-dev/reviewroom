---
status: accepted
---

# Review modes share a workbench; the guided walkthrough tells the story and the walkthrough keeps the record

Reviewing a teammate's PR needs a different starting point from reviewing the agent's own work. The reviewer
needs to understand the diff first, then assess findings and evidence. Treating the two documents as "one story,
two views" (rr-7ji) makes the detailed review repeat the slides and obscures their different jobs.

**Decision:** derive three modes from two facts: whether there is a PR, and whether the reviewer is its author.
Keep one workbench. Present the guided walkthrough first, then the detailed review record. Deliver the generation
flow in Release 1 for every review; add mode detection and Peer-specific UI in Release 2 (rr-wd3).

## Decision

1. **Modes.** Choose once when the review opens:

   | PR exists | Reviewer is its author | Mode |
   | --- | --- | --- |
   | No | — | Draft |
   | Yes | Yes | Author |
   | Yes | No | Peer |

   Modes share the hub, dock, code, player, walkthrough and threads. They differ in the header badge, primary action,
   default comment destination, default layout and what the agent may do. Draft and Author keep today's view;
   their redesigns come later.
2. **Two documents, two jobs.** The guided walkthrough (`walkthrough.json`) is the story: slides pinned to one
   snapshot, played first and regenerated when the reviewed code moves. The walkthrough (`review.html`) is the record:
   detailed findings, evidence, open questions and later answers. They need not mirror each other's sections.
   This replaces rr-7ji's "one story, two views".
3. **Guided walkthrough first.** Outline the intro and story, ending with a **Risks** chapter. Each main risk is
   one line with a severity and an `rr:doc/<section id>` link to its finding; detailed findings stay in `review.html`.
   Create a heading-only `review.html` skeleton from the outline, including the finding sections, so those links
   resolve. Then write `walkthrough.json` and run full `reviewroom slide-lint` until it passes. Only then fill
   `review.html` and run `reviewroom check`. Scoped slide checks do not clear the loading screen.
   Small diffs use fewer slides. If the PR ships a guided walkthrough, use it as is.
4. **Peer record.** Suggest Summary (including a verdict), Findings (most serious first), Questions for the author,
   Evidence, Your questions. Each top-level part is a `<section id>` for Contents and section navigation. Findings
   give where, what is wrong, why it matters, evidence and a suggested direction. This is agent-written HTML, not
   a new element or validation contract. Review profiles are composable skill references saying what to look for
   and which sections or findings to add. Ship the default profile and an index; add a profile with a file and
   one index entry.
5. **Peer agent.** Explain and review; never change code, including in later rounds. Until mode detection exists,
   the skill compares the PR author's login (`gh pr view`) with the authenticated login (`gh api user`). Private
   answers collect under Your questions. In the planned Peer UI, Ask the agent is private and the reviewer's
   comments go to GitHub on Submit review.
6. **Names.** Keep today's UI and vocabulary in Release 1: **Guided walkthrough** means slides; **Walkthrough** means
   `review.html`. The decided UI names are **Walkthrough** for slides and **Report** for `review.html`, landing with
   rr-wd3.7. Keep code identifiers, `walkthrough.json` and public links compatible.

## Considered options

- *One story, two views, kept in step section by section* (rr-7ji): replaced. The slides teach the diff once;
  the record grows with the review.
- *A separate workbench for each mode*: rejected. The shared layers already support each review; defaults and
  agent permissions provide the distinction.
- *A new finding element or enforced report schema*: not needed. A suggested outline and composable profiles
  guide ordinary HTML without changing validation.
- *Make the guided walkthrough optional for small PRs*: rejected. Reduce the number of slides instead.

## Consequences

- **Release 1** (rr-wd3.1, rr-wd3.3, rr-wd3.4, rr-wd3.5): documentation, CLI-owned generation progress, loading
  screen and skill. The guided walkthrough comes first for every review, without a mode field. A full passing
  slide audit clears its loading screen; the walkthrough panel remains in its writing state until `check` passes.
- **Release 2** (rr-wd3.2, rr-wd3.6, rr-wd3.7): stored mode, badge, Peer defaults and UI names. The new terms in
  `CONTEXT.md` record the decision without renaming today's UI early.
- The reviewer's own agent session runs the skill. A built-in agent, one-click generation, finding-to-GitHub
  comments, staged replies and chapter-by-chapter playback during writing remain outside this release.
