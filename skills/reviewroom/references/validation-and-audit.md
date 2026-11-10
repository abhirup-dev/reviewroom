# Validation and audit

Pass `--dir <dir>` to every command below. Use command-specific `--help` for other flags.

## Before handover

```bash
reviewroom check --fix --dir <dir>
reviewroom slide-lint --dir <dir>
```

`check --fix` validates links and schema, updating links moved within five lines. Inspect remaining
changed or broken links and update the explanation. Use `check --accept` only after verifying changed targets.
`reviewroom check --help` prints the walkthrough schema path for editor validation.

**For guided walkthroughs, full `slide-lint` is the main final check.** It includes schema and link
validation, checks every slide at 1280×800 and 1440×900, and reports coverage, pacing, focus,
overflow, hidden code, stripped prose and page errors. Run it once for the whole walkthrough,
rather than invoking it separately for every slide. Skip it when there is no `walkthrough.json`.

## While iterating

| Command | Use |
| --- | --- |
| `reviewroom check` | Static validation without rendering. |
| `reviewroom slide-lint --chapter services` | Recheck one chapter. |
| `reviewroom slide-lint --slide services/s1` | Recheck one slide. |
| `reviewroom slide-lint --jobs 2` | Parallel full audit; gains vary and can be modest. |

Selectors use chapter and step **IDs**, not titles or positions. `--slide` also accepts
`rr:tour/services/s1`; do not combine it with `--chapter`. Scoped checks retain chapter leads
and inherited code, but skip whole-walkthrough coverage and pacing. The entire schema is still
validated. Startup still costs time. Finish with an unscoped run.

`--jobs` accepts 1–8; default 1. More workers can add contention, so do not assume they are faster.
`--json` gives structured findings and, for slide audits, the selection and coverage.

## Screenshots when needed

| Command | Use |
| --- | --- |
| `reviewroom shot [section]` | Walkthrough screenshots. |
| `reviewroom shot services/s1` | One guided slide. |
| `reviewroom shot services/s1 --prose-only` | Exact left-pane crop; skips right-hand code. |

Screenshots default to a 480-pixel height cap; add `--native` when text is blurry or detail matters.
Neither changes the CSS layout. `--prose-only` preserves pane proportions and renders embedded
prose code; it excludes right-pane findings and is not a replacement for full slide lint.
Use it for framing, not as a guaranteed speedup. Use `--theme dark` or `--viewport 1440x900`
when inspecting those presentations (`--viewport` is for slides).

## Reading findings

- `slide-lint` warnings or broken links exit 1. `unsettled` means rendering did not finish; recheck it.
- Static budget notes are estimates, not visual proof, and do not fail `check`.
- Start with about 25 highlighted lines, or 10 per stacked ref; at most two refs. Rendered findings decide fit.
- Coverage counts files linked in slide prose too; changes under 10 lines, tests, generated files, dependencies, locks and docs get informational notes.
- Headless audits disable motion automatically; no manual animation waits are needed.
- Slide lint and screenshots do not modify the review. `check` records fingerprints; `--fix` may rewrite links.
