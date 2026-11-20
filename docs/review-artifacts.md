# Review artifacts

What an agent writes into a review folder. Code names each file through its constant in
`src/kernel/state/files.shared.ts`, never the literal; docs say "the report" or "the walkthrough" and link here.

| Artifact | Constant | File | What it is |
| --- | --- | --- | --- |
| Report | `REPORT_FILE` | `report.html` | Agent-written HTML: only what goes inside `<rr-review>`. `reviewroom pr` creates it from the review's title and report profile. The server serves it inside reviewroom's page shell (`cli/lib/report-page.ts`: head, client entry, `<rr-app>`, `<rr-review>`); older reports that carry a shell of their own still work. |
| Walkthrough | `WALKTHROUGH_FILE` | `walkthrough.json` | The slides, following `schema/walkthrough.schema.json`. It can also come from the PR description. |
| Assets | none | any | Images, CSS or JS the report links, beside it. |

A report profile's sections file (`skills/reviewroom/references/profiles/<name>/`) is also named by `REPORT_FILE`.
Everything else in the review folder belongs to reviewroom: [review state](review-state.md).
The agent reports generation progress through the CLI (`reviewroom progress <review> read` once it has read the diff,
then `slide-lint` and `check`), never by writing it.

Download in the live desktop walkthrough player or run `reviewroom export <review>` to save an offline HTML file
with the player, walkthrough and full source of the files it shows. The default filename is the slugged
`<review-id>-<title>.html`, capped at 100 characters. The CLI writes to the current directory unless given
`--out <path>`, which uses the supplied path as written.
