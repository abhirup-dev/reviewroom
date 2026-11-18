# Review state

What reviewroom keeps for itself, beside what the agent writes ([review artifacts](review-artifacts.md)). Agents and
reviewers don't edit these files; they change them through the CLI and the page.

## In a review folder

A review folder is `~/.reviewroom/reviews/<owner>-<repo>/<branch>/` by default, never inside the reviewed repo.

| File | Written by | Holds |
| --- | --- | --- |
| `config.json` | the CLI (`reviewroom pr`) | What is reviewed: repo path, base, head, title, the PR (repo, number, author, URL, labels) and the report profile. Schema in `cli/lib/config.ts`. |
| `state.json` | the CLI, the browser (through the server) and agents (through the CLI) | Threads, rounds, viewed files, sign-offs. |
| `state.lock` | the CLI and the server | `{pid, port}`. A running server holds it for its lifetime; the CLI holds it for one read-modify-write, and sends its writes to the server while the server holds it. |
| `server.json` | `reviewroom serve` | The running server, so other commands find it. |
| `progress.jsonl` | the CLI and the server, never the agent | Generation, per document (below). Drives the loading screen. |
| `layout.json` | the browser | The dock as the reviewer left it. |
| `github.json` | the server | The last PR snapshot from GitHub. |
| `assistant.json` | the server | The built-in assistant's transcript (below). |
| `rounds/<n>/` | the server | Each finished round: a snapshot of the report and `feedback.md`. |

**`state.json`** is a contract: change it in `src/kernel/state/schema.shared.ts`, then `bun run schema` to regenerate
`schema/state.schema.json`. A file that doesn't parse or breaks the schema is moved aside (`<file>.corrupt-<time>`) with
an error, never silently started over; a read-only server never moves it.

**`progress.jsonl`** appends events per document (walkthrough, report); `src/kernel/state/progress.shared.ts` reduces
them to a state, and the client reads that state rather than the events:

| Event | State | Written by |
| --- | --- | --- |
| (none) | `idle` | |
| `requested`, `by: agent` or `assistant` | `requested` | `reviewroom pr` for a new or `--force`d review (`agent`; not with `--no-agent`), or `api/generate` (`assistant`) |
| `written`, with the content hash | `writing` | the server, when the file changes |
| `validated`, with the hash | `validated` while the file still has that hash, else `writing` | `slide-lint` (a full run) and `check` |
| `stopped`, `reason: failed` or `interrupted` | `stopped` | the server: an assistant generation turn ended with the document unvalidated (`failed`), or a server started while an assistant generation was pending (`interrupted`; turns live in the server's process) |

Events before the first `requested` are ignored (a review that never asked for generation stays `idle`). `stopped` keeps
what was written and stays through later saves; a validation or a new request leaves it. An `agent`'s request is never
stopped by the server, which can't know whether an outside agent is still at work. `/api/progress` and the `progress`
event add `generation: { running, awaitingApproval }` where the assistant runs.

**`assistant.json`** stores the review's AI SDK transcript and opaque harness resume state (private, mode 0600).
Reopening with the same installation restores the transcript and resumes its existing native session. The harness
owns recovery; changing the installation path or agent dependencies can invalidate native resume. A corrupt one is
moved aside like `state.json` and blocks the assistant (not the review) until restored or deleted; one started from
another checkout is kept and refused there. A reviewer's question runs under the session's own policy (`allow-reads`,
and the panel's approvals for anything else). A generation turn (`POST api/generate`) approves every tool request itself
and continues, so it never waits on the reviewer (`generationApproval()` in `cli/lib/assistant.ts`). The assistant answers
only the review's own URL: the hub proxy marks what
it forwards (`x-reviewroom-via-hub`) and the review server refuses it, `api/generate` included (ADR 0001: no identity yet).

## In `~/.reviewroom/`

`REVIEWROOM_HOME` overrides the root.

- `reviews/`: the review folders (above).
- `sessions/<pid>.json`: one per running server, read by `reviewroom hub` (which deletes records whose server is gone)
  and other local tools. `hub.json` is the running hub.
- `layouts/<name>.json`: the reviewer's saved layouts, in the format of `src/kernel/layouts/layout.shared.ts` like the
  shipped ones in `src/kernel/layouts/` (whose names they can't take). `default-layout.json` names their default.
- `config.json`: the reviewer's settings. `assistant: true` turns the built-in assistant on (as `REVIEWROOM_ASSISTANT`
  does); read when a review server starts. `publicOrigin` (`reviewroom hub --public-origin`, ADR 0001), read when the
  hub starts; `defaultAgentHarness` (`claude` only), `defaultReviewModel` (`sonnet` by default) and
  `reviewAgentPromptFile` (optional Markdown prompt path, relative to this file); `claudeExecutable` overrides the
  Claude binary (otherwise the native override environment, `claude` on PATH, then the adapter's bundled binary).
  Model defaults are reread before new questions; restart for other changes.
- `assistant/`: the assistant harness's runtime and session files (`.ai-sdk-harness/`). Its setup commands use
  `assistant/` as HOME, while the native agent keeps the reviewer's real HOME and login.
