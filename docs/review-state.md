# Review state

What reviewroom keeps for itself, beside what the agent writes ([review artifacts](review-artifacts.md)). Agents and
reviewers don't edit these files; they change them through the CLI and the page.

## In a review folder

A review folder is `~/.reviewroom/reviews/<owner>-<repo>/<branch>/` by default, never inside the reviewed repo.

| File | Written by | Holds |
| --- | --- | --- |
| `config.json` | the CLI (`reviewroom pr`) | What is reviewed: repo path, base, head, title, the PR (repo, number, author, URL, labels) and the report profile. `assistant: true`: this review runs the built-in assistant (its Ask panel and `api/generate`), set by the hub's Play and `pr --assistant`, never by an external agent's `pr`. Schema in `cli/lib/config.ts`. |
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
| `requested`, `by: agent` or `assistant`, with a request `id` | `requested` | `reviewroom pr` for a new or `--force`d review (`agent`; not with `--no-agent`), or `api/generate` (`assistant`, only the documents not validated now). A line without `by` was an agent's. |
| `written`, with the content hash | `writing` | the server, when the file changes |
| `validated`, with the hash | `validated` while the file still has that hash, else `writing` | `slide-lint` (a full run) and `check` |
| `stopped`, `reason: failed` or `interrupted`, naming the `request` it stops; `stale`: the validated hash it saw edited since | `stopped`, only while that request is current and unfinished (or validated with exactly that `stale` hash) | the server: an assistant generation turn ended with the document unvalidated (`failed`), or the server closed during an assistant generation, or a server started while one was pending (`interrupted`; turns live in the server's process) |
| `reset` | `idle` | `reviewroom pr --force --no-agent` |

Requests and stops of both documents go in one write. Events before the first `requested` are ignored (a review that never asked for generation stays `idle`), except a walkthrough imported from the PR (`validated`, `source: pr`): it counts while the file has those bytes, and edited since, with nobody asked, is `idle` again. `stopped` keeps
what was written and stays through later saves; a validation or a new request leaves it. An `agent`'s request is never
stopped by the server, which can't know whether an outside agent is still at work. `/api/progress` and the `progress`
event add `generation: { running, awaitingApproval }` where the assistant runs.

**`assistant.json`** stores the review's AI SDK transcript and opaque harness resume state (private, mode 0600).
Reopening with the same installation restores the transcript and resumes its existing native session. The harness
owns recovery; changing the installation path or agent dependencies can invalidate native resume. A corrupt one is
moved aside like `state.json` and blocks the assistant (not the review) until restored or deleted; one started from
another checkout is kept and refused there. Every assistant turn, a generation (`POST api/generate`) or a reviewer's question,
runs with every tool approved (`allow-all`), so none waits on the reviewer. The assistant answers
only the review's own URL: the hub proxy marks what
it forwards (`x-reviewroom-via-hub`) and the review server refuses it, `api/generate` included (ADR 0001: no identity yet).

## In `~/.reviewroom/`

`REVIEWROOM_HOME` overrides the root.

- `reviews/`: the review folders (above).
- `sessions/<pid>.json`: one per running server, read by `reviewroom hub` (which deletes records whose server is gone)
  and other local tools. `hub.json` is the running hub.
- `layouts/<name>.json`: the reviewer's saved layouts, in the format of `src/kernel/layouts/layout.shared.ts` like the
  shipped ones in `src/kernel/layouts/` (whose names they can't take). `default-layout.json` names their default.
- `config.json`: the reviewer's settings. Whether the built-in assistant runs is not one of them: it is chosen per
  review (`assistant` in the review's own `config.json`, above), read when its server starts. `publicOrigin` (`reviewroom hub --public-origin`, ADR 0001), read when the
  hub starts; `defaultAgentHarness` (`claude` only), `defaultReviewModel` (`sonnet` by default) and
  `reviewAgentPromptFile` (optional Markdown prompt path, relative to this file); `claudeExecutable` overrides the
  Claude binary (otherwise the native override environment, `claude` on PATH, then the adapter's bundled binary).
  Model defaults are reread before new questions; restart for other changes.
- `repos/<owner>/<repo>/`: the clones the hub's Add a PR makes (fetched again when a PR of that repository is added).
- `assistant/`: the assistant harness's runtime and session files (`.ai-sdk-harness/`). Its setup commands use
  `assistant/` as HOME, while the native agent keeps the reviewer's real HOME and login.
