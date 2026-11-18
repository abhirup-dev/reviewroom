# Default review profile

## What to look for

Trace the changed behaviour through its callers, contracts and failure paths. Check correctness,
compatibility and what the tests establish. Separate evidence from assumptions; name gaps in what
you could verify. Report actionable problems and their impact, not an inventory of observations.

## Sections and findings

For someone else's PR, use this suggested outline in the report (`report.html`). Each top-level part
is a `<section id>` with an `<h2>`: Contents and `]` / `[` navigate those parts. Keep the HTML inside
loose; no new element or check is needed. For other reviews, follow `../report-craft.md`.

| Part | Include |
| --- | --- |
| Summary | What the diff does and a suggested verdict, with reasons. This is advice to the reviewer, not a submitted GitHub review. |
| Findings | Most serious first. Each finding states where, what is wrong, why it matters, evidence and a suggested direction. Give it a severity and a stable section id. |
| Questions for the author | Uncertainties the author needs to settle. Keep them distinct from established findings. |
| Evidence | What you inspected or ran, the results and what remains unverified. Link code and tests; distinguish the PR description's claims from your own checks. |
| Your questions | The reviewer's later questions and your answers. Link or embed each thread; keep substantial answers here across rounds. |

Start with headings only while outlining:

```html
<section id="summary"><h2>Summary</h2></section>
<section id="findings">
  <h2>Findings</h2>
  <section id="finding-retry-loss"><h3>High: retries can discard queued work</h3></section>
</section>
<section id="author-questions"><h2>Questions for the author</h2></section>
<section id="evidence"><h2>Evidence</h2></section>
<section id="your-questions"><h2>Your questions</h2></section>
```

Use ids and headings from the actual review. Create one finding section per risk before writing
slides; the final Risks chapter links each one-liner to it, for example
`<a href="rr:doc/finding-retry-loss">High: retries can discard queued work</a>`.
Fill the sections only after the full slide audit passes. If there are no findings or author
questions, say so. Leave Your questions ready for later rounds.
