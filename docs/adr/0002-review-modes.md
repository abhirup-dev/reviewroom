---
status: accepted
---

# Peer review: the walkthrough tells the story, the report keeps the record

Reviewing a teammate's PR starts from not knowing the change. The reviewer needs to understand the diff first, then
weigh findings and evidence. Treating the two documents as "one story, two views" (rr-7ji) made the report repeat the
slides and blurred their different jobs.

**Decision:** build reviewroom around Peer review (someone else's PR) on one workbench. The walkthrough is generated
first and played first; the report follows as the detailed record. Other modes are not described yet.

## Decision

1. **Two documents, two jobs.** The walkthrough (`walkthrough.json`) is the story: slides pinned to one snapshot,
   played first and regenerated when the reviewed code moves. The report (`review.html`) is the record: findings,
   evidence, flagged questions and later answers. They need not mirror each other's sections.
2. **Walkthrough first.** Outline the intro and story, ending with a **Risks** chapter. Each main risk is one line
   with a severity and an `rr:doc/<section id>` link to its finding; detailed findings stay in the report. Create a
   heading-only report skeleton from the outline, including the finding sections, so those links resolve. Then
   write `walkthrough.json` and run full `reviewroom slide-lint` until it passes. Only then fill the report and run
   `reviewroom check`. Scoped slide checks do not clear the loading screen. Small diffs use fewer slides. If the
   PR ships a walkthrough, use it as is.
3. **Generation is visible.** The CLI and server, never the agent, append to `progress.jsonl` in the review dir:
   `requested`, `written` and `validated` per document, with the content hash. The reviewer sees a loading screen
   until the walkthrough is validated; `validated` holds only while the file still has that hash.
4. **The report's shape.** Suggest Summary (including a verdict), Findings (most serious first), Questions for the
   author, Evidence, Your questions. Each top-level part is a `<section id>` for Contents and section navigation.
   Findings give where, what is wrong, why it matters, evidence and a suggested direction. This is agent-written
   HTML, not a new element or validation contract. Review profiles are composable skill references saying what to
   look for and which sections or findings to add: a default profile and an index; another profile is a file and
   one index entry.
5. **The agent explains, never changes code.** In Peer review the agent explains and reviews, in every round. The
   skill tells Peer review apart by comparing the PR author's login (`gh pr view`) with the authenticated login
   (`gh api user`). The reviewer's questions and their answers collect under Your questions.

## Considered options

- *One story, two views, kept in step section by section* (rr-7ji): replaced. The slides teach the diff once;
  the report grows with the review.
- *A separate workbench per kind of review*: rejected. The shared layers already serve each review; defaults and
  agent permissions make the distinction.
- *A new finding element or enforced report schema*: not needed. A suggested outline and composable profiles
  guide ordinary HTML without changing validation.
- *An optional walkthrough for small PRs*: rejected. Use fewer slides instead.
- *The agent reporting its own progress*: rejected. Progress written by the CLI and server from what is on disk
  cannot drift from the files.

## Consequences

- Every review gets a walkthrough before its report; the loading screen depends on the CLI's progress log, so an
  agent that skips `slide-lint` or `check` leaves the reviewer waiting with a "Show it anyway" escape.
- Code identifiers predate this vocabulary (`review.html`, the `narrative` panel, `src/review/walkthrough.ts` for
  the report); public names and links stay compatible.
