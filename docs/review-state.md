# Review state

What reviewroom keeps for itself, beside what the agent writes ([review artifacts](review-artifacts.md)). Agents and
reviewers don't edit these files; they change them through the CLI and the page.

## In a review folder

A review folder is `~/.reviewroom/reviews/<owner>-<repo>/<branch-or-pr-n>/` by default, outside the reviewed repo.
A PR number or URL maps to `pr-<n>`. Use `--dir` to work with a custom directory.

| File | Written by | Holds |
| --- | --- | --- |
| `config.json` | the CLI (`reviewroom pr`) | Repo path, base, head, title, PR metadata, report profile and the CLI target for a default review folder. Schema in `cli/lib/config.ts`. |
| `state.json` | the CLI, the browser (through the server) and agents (through the CLI) | Threads, rounds, viewed files, sign-offs. |
| `state.lock` | the CLI and the server | `{pid, port}`. A running server holds it for its lifetime; the CLI holds it for one read-modify-write, and sends its writes to the server while the server holds it. |
| `server.json` | `reviewroom start --foreground` | The running server, so other commands find it. |
| `server.log` | the detached server | Server stdout and stderr. |
| `progress.jsonl` | the CLI and the server, never the agent | Generation: `requested`, `written` and `validated` per artifact, with the content hash. `validated` holds only while the file still has that hash. Drives the loading screen. |
| `layout.json` | the browser | The dock as the reviewer left it. |
| `github.json` | the server | The last PR snapshot from GitHub. |
| `assistant.json` | the server | The built-in assistant's transcript (below). |
| `rounds/<n>/` | the server | Each finished round: a snapshot of the report and `feedback.md`. |

**`state.json`** is a contract: change it in `src/kernel/state/schema.shared.ts`, then `bun run schema` to regenerate
`schema/state.schema.json`. A file that doesn't parse or breaks the schema is moved aside (`<file>.corrupt-<time>`) with
an error, never silently started over; a read-only server never moves it.

`pr` and `start` reuse the review's running server. `wait` starts a detached server if needed, then
reads the round queue from `state.json`. The server saves `feedback.md` before publishing the finished
round in state. `wait` prints the oldest undelivered round and records `deliveredAt` via the normal
state operation after stdout flushes. A retry can reprint a round if interrupted before that write.
The server stays up through feedback and approval. Stop it with `reviewroom stop <target>` or the hub's Close.

**`assistant.json`** stores the review's AI SDK transcript and opaque harness resume state (private, mode 0600).
Reopening with the same installation restores the transcript and resumes its existing native session. The harness
owns recovery; changing the installation path or agent dependencies can invalidate native resume. A corrupt one is
moved aside like `state.json` and blocks the assistant (not the review) until restored or deleted; one started from
another checkout is kept and refused there. The assistant answers only the review's own URL: the hub proxy marks what
it forwards (`x-reviewroom-via-hub`) and the review server refuses it (ADR 0001: no identity yet).

## In `~/.reviewroom/`

`REVIEWROOM_HOME` overrides the root.

- `reviews/`: the review folders (above).
- `sessions/<pid>.json`: one per running server, read by `reviewroom hub` (which deletes records whose server is gone)
  and other local tools. `hub.json` is the running hub.
- `layouts/<name>.json`: the reviewer's saved layouts, in the format of `src/kernel/layouts/layout.shared.ts` like the
  shipped ones in `src/kernel/layouts/` (whose names they can't take). `default-layout.json` names their default.
- `config.json`: the reviewer's settings. `publicOrigin` (`reviewroom hub serve --public-origin`, ADR 0001), read when the
  hub starts; `defaultAgentHarness` (`claude` only), `defaultReviewModel` (`sonnet` by default) and
  `reviewAgentPromptFile` (optional Markdown prompt path, relative to this file); `claudeExecutable` overrides the
  Claude binary (otherwise the native override environment, `claude` on PATH, then the adapter's bundled binary).
  Model defaults are reread before new questions; restart for other changes.
- `assistant/`: the assistant harness's runtime and session files (`.ai-sdk-harness/`). Its setup commands use
  `assistant/` as HOME, while the native agent keeps the reviewer's real HOME and login.
