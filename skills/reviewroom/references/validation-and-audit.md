# Validation and audit

Both commands print what failed, how to fix it, and the next command (`help:`); `--help` has the
flags and checks.

## Write and validate in order

If the PR shipped a walkthrough pulled by `reviewroom pr`, it was validated before publication.
Use it as is and go straight to filling the report; do not regenerate it.

Otherwise record that you have read the diff, then write the walkthrough (SKILL.md, Step 4), then run
`reviewroom slide-lint <review>` until a **full** run passes, before filling the report. It validates
schema and links, measures every slide on screen, and reports coverage, pacing, focus, overflow,
hidden code, stripped prose and page errors. A passing full run clears the reviewer's loading screen;
scoped runs (`--slide`, `--chapter`) are for iterating and do not count.

Then fill the report and run `reviewroom check <review> --fix` until it passes. Use `--accept` only
after re-reading changed targets. The report panel stays in its writing state until `check` passes.

On later rounds, recheck edited content. If you edit the walkthrough, pass full `slide-lint` again;
the loading screen returns until it passes. Finish edits to the report with `check`.

## Screenshots when needed

Use `reviewroom shot <review> [section]` (or `<chapter>/<step>` for a slide) when a finding is unclear
or the layout matters: a diagram, a wide table, dense prose. Add `--native` when text is blurry,
`--theme dark` or `--mobile` to check those views.

## Reading findings

- `unsettled` means rendering did not finish; recheck it.
- Static budget notes are estimates, not visual proof; rendered findings decide fit.
- Coverage counts files linked in slide prose too; changes under 10 lines, tests, generated files, dependencies, locks and docs get informational notes.
- Headless audits disable motion automatically; no manual animation waits are needed.
