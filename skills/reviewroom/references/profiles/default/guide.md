# Default report profile

## What to look for

Trace the changed behaviour through its callers, contracts and failure paths. Check correctness,
compatibility and what the tests establish. Separate evidence from assumptions; name gaps in what
you could verify. Report actionable problems and their impact, not an inventory of observations.

## Sections

The report (`report.html`) starts with these top-level sections from `report.html` in this folder.
Each is a `<section id>` with an `<h2>`: Contents and `]` / `[` navigate them. Keep the ids; the
HTML inside is yours, and no new element or check is needed. `../../report-craft.md` has the
writing guidance within them.

| Section (id) | Holds |
| --- | --- |
| Summary (`summary`) | What the diff does and a suggested verdict, with reasons. This is advice to the reviewer, not a submitted GitHub review. |
| Findings (`findings`) | Most serious first. Each finding states where, what is wrong, why it matters, evidence and a suggested direction. Give it a severity and a stable section id. |
| Questions for the author (`author-questions`) | Uncertainties the author needs to settle. Keep them distinct from established findings. |
| Evidence (`evidence`) | What you inspected or ran, the results and what remains unverified. Link code and tests; distinguish the PR description's claims from your own checks. |
| Your questions (`your-questions`) | The reviewer's later questions and your answers. Link or embed each thread; keep substantial answers here across rounds. |

## Findings

While outlining the walkthrough, add one heading-only finding section per risk under Findings:

```html
<section id="finding-retry-loss"><h3>High: retries can discard queued work</h3></section>
```

Use ids and headings from the actual review. The final Risks chapter links each one-liner to its
finding, for example `<a href="rr:doc/finding-retry-loss">High: retries can discard queued work</a>`.
Fill the sections only after the full slide audit passes. If there are no findings or author
questions, say so. Leave Your questions ready for later rounds.
