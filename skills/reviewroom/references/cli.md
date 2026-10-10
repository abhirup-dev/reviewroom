# CLI and the round loop

All commands accept `--repo <path>` (defaults to the git repo of the cwd) and `--dir <review dir>`
(defaults to `<repo>/.reviewroom/<branch>`; `pr` uses `.reviewroom/pr-<n>`).

| Command | What it does |
|---|---|
| `reviewroom pr <number \| PR url \| branch> [--detach] [--wait] [--base <ref>] [--title "…"] [--port N] [--no-open]` | Fetch the PR head (`refs/pull/<n>/head`, metadata from `gh` when logged in), scaffold `review.html` if missing, start the server. `--detach` backgrounds it and prints the URL; `--wait` blocks like `review`. |
| `reviewroom status [--json]` | Round, threads, threads awaiting your reply; `--json` adds base/head shas, review path and server URL. |
| `reviewroom serve` | Run the server in the foreground (never exits). |
| `reviewroom review` | Run the server, open the browser if no tab connects, **block** until the reviewer sends feedback or approves, print the feedback, exit. Takes over a detached server on the same port. If the reviewer finished a round while you were not waiting, prints that feedback right away and exits (a running server keeps running). |
| `reviewroom threads [--all] [--json]` | List open (or all) threads with their messages. |
| `reviewroom reply <thread-id> "<markdown>" [--resolve]` | Answer a thread as the agent (`-` or `--file f.md` for long bodies). |
| `reviewroom reply --json <file \| ->` | Answer several threads at once: `[{"thread": "t_ab12", "body": "…", "resolve": true}]`. All or nothing. |
| `reviewroom comment <rr-ref \| general> "<markdown>"` | Start a thread yourself, e.g. to point the reviewer at something. |
| `reviewroom resolve <thread-id>` | Mark resolved. |
| `reviewroom stop` | Stop a detached server. |
| `reviewroom init [--base] [--head] [--title]` | Scaffold without fetching (local branches, `--head worktree` for uncommitted changes). |

Thread ids can be abbreviated to a unique prefix.

`pr` never prompts: if the fetch fails (offline, SSH key not loaded, no `gh`), it falls back to a
local branch named `pr-<n>` or `pr/<n>` and says so; otherwise pass the branch name instead of the
number. Without `gh` there is no PR title or author: pass `--title`, or the oldest commit subject is used.

## Rounds

- Round 1 starts when the review is created. The reviewer's comments are tagged with the current round.
- *Send feedback* closes the round: `review` prints the feedback and exits, the narrative is
  snapshotted to `rounds/<n>/review.html`, the feedback saved to `rounds/<n>/feedback.md`, and the
  round number advances. Your replies are tagged with the new round.
- Mark sections you add or substantially change with `data-round="<new round>"`; they get a
  "new in Rn" marker and the reviewer can compare with earlier rounds from the Round menu.
- *Approve* ends the loop. Open threads stay open; ask before resolving them yourself.

## The feedback you receive

Markdown, one block per thread that has new reviewer comments this round:

```
## Thread t_ab12cd34 — open
Anchor: pkg/ranker/request_builder.go:51-53 (new/head side)  (rr:code/pkg/ranker/request_builder.go#L51-53)
<code excerpt for code anchors>
**you** (round 1): …earlier message…
**agent** (round 2): …your earlier reply…
**you** (round 2) — NEW: …the new comment…
```

Anchors tell you exactly what the comment is about: a code range (with side), a narrative element
(section id, optional CSS path to a block, optional quoted text), a symbol, or general. A sign-off
checklist summary and an overall note may follow.

## Where state lives

`<repo>/.reviewroom/<name>/` (added to `.git/info/exclude` automatically):
`review.html` (yours), `config.json` (base/head/title), `state.json` (threads, rounds, viewed files,
sign-offs; schema in `schema/state.schema.json`), `rounds/<n>/`, `server.json` / `server.log` while
a server runs, and `state.lock` (held by the running server, or briefly by a CLI write).

While a server runs it is the only writer of `state.json`: `reply`, `comment` and `resolve` send
their change to it, so the reviewer's open tab and your replies never overwrite each other. With no
server they write the file directly under the lock. Don't edit `state.json` by hand while a server
runs (it won't notice); otherwise keep it valid against the schema. A `state.json` that is not valid
JSON is moved to `state.json.corrupt-<time>` and the command fails rather than starting over.
