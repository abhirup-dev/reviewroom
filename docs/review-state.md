# Review state

What reviewroom keeps beside the agent's documents ([review artifacts](review-artifacts.md)). Agents and reviewers
change it only through the CLI and the page.

## The store

Every file in a review folder is declared once in `REVIEW_FILES` (`cli/lib/review-store.ts`: name, schema, write rule)
and reached only through `reviewStore(dir)`. JSON is validated on read and written atomically; `progress.jsonl` is
append-only. A broken JSON file is moved aside (`state.json`, `assistant.json`), reported (`config.json`) or read as
missing (caches and records), as declared. None of these files, nor `rounds/`, is served; only the agent's documents
and assets are.

`reviewSummary(dir)` (`cli/lib/review-summary.ts`) derives a review's status from its folder alone: round, thread
counts, generation, whose move it is, last activity. The hub uses it for every review, running or stopped, and
`api/summary` returns it.

## In a review folder

Review folders live outside the checkout; PR reviews at `<home>/reviews/<owner>_<repo>/pulls/<n>/`, whose
`config.json` carries a write-once `id` matching the folder.

| File | Written by | Holds |
| --- | --- | --- |
| `config.json` | `reviewroom pr` | Repo, base, head, PR metadata, report profile. `reportScaffoldHash`: the untouched scaffold (Remove asks before losing edits). `assistant: true`: the built-in assistant runs this review (hub Play, `pr --assistant`). |
| `state.json` | the CLI and the server | Threads, rounds, viewed files, sign-offs. Schema in `src/kernel/state/schema.shared.ts`; `bun run schema` regenerates `schema/state.schema.json`. |
| `state.lock` | the CLI and the server | `{pid, port}`. A running server holds it; otherwise the CLI holds it for one write. While a server holds it, the CLI sends writes to the server. |
| `server.json`, `server.log` | the review server | The running server; its output. |
| `closed.json` | `stop`, the hub's Close | The review was closed on purpose: a pending `wait` exits 3. The next start removes it. |
| `progress.jsonl` | the CLI and the server | Generation events per document (below). |
| `layout.json` | the browser | The dock as the reviewer left it. |
| `github.json` | the server | The last PR snapshot. |
| `assistant.json` | the server | The assistant's transcript and resume state (mode 0600). |
| `assistant-process.json` | the server | The assistant's process group, reaped after a crash. |
| `rounds/<n>/` | the server | Each finished round: the report snapshot and `feedback.md`. |

**Rounds.** The server saves `feedback.md`, then marks the round sent. `wait` prints the oldest undelivered round and
then records `deliveredAt`; an interrupted `wait` can reprint it.

**`progress.jsonl`** is reduced to one state per document by `src/kernel/state/progress.shared.ts`:

| Event | State | Written by |
| --- | --- | --- |
| (none) | `idle` | |
| `requested` (`by: agent` or `assistant`, an `id`) | `requested` | `pr` on a new or `--force`d review; `api/generate` |
| `read` (walkthrough, naming its request) | `writing` | `reviewroom progress <review> read` |
| `written` (hash) | `writing` | the server, when the file changes |
| `validated` (hash) | `validated` while the file has that hash | full `slide-lint`, `check` |
| `stopped` (`failed` or `interrupted`, naming its request) | `stopped` | the server, for the assistant's turns only |
| `reset` | `idle` | `pr --force --no-agent` |

Events before the first request are ignored, except a walkthrough imported from the PR. An agent's request is never
stopped by the server. Unknown events are skipped.

**The assistant** runs each turn with every tool approved. A turn's stream lives in server memory and is served at
`api/assistant/<chatId>/stream?turn=<id>`; leaving the page doesn't stop it, `POST api/assistant/stop` does. It answers
only the review's own URL, never through the hub (ADR 0001).

## In `~/.reviewroom/`

`REVIEWROOM_HOME` overrides the root.

- `reviews/`: the review folders.
- `sessions/<pid>.json`: one per running server, for `list` and the hub (which deletes stale ones). `hub.json`: the
  running hub.
- `layouts/<name>.json`: saved layouts (`src/kernel/layouts/layout.shared.ts`); `default-layout.json` names the default.
- `config.json`: the reviewer's settings: `publicOrigin`, `defaultAgentHarness`, `defaultReviewModel`,
  `defaultReviewEffort`, `reviewAgentPromptFile`, `claudeExecutable`.
- `repos/<owner>/<repo>/`: clones made by the hub's Add.
- `assistant/`: the assistant harness's runtime files.
