---
name: readingroom-review
description: Run an agent-guided code review in readingroom - write a linked narrative of a PR or branch, open it for the reviewer, and work through round-based feedback threads. Use when the user asks to review a PR/branch "in readingroom", for a guided review, or to answer their readingroom feedback.
---

# readingroom review loop

readingroom is a local review workbench: a freeform HTML narrative you write, next to a live diff
read from the local clone, with anchored comment threads and rounds. Full authoring guide:
`AGENTS.md` in the readingroom package (`npm root -g`/readingroom/AGENTS.md, or the repo).

## 1. Understand the change

- Identify base and head (`gh pr view <n> --json baseRefName,headRefName,title,number,author` for a PR;
  check it out locally — readingroom reads git, not the GitHub API).
- Read the diff (`git diff <base>...HEAD --stat`, then the files). Find the entry point, the new code,
  storage/proto/config changes, failure paths and tests.

## 2. Write the narrative

```bash
readingroom init --base <base> --title "<title>" [--number <n>] [--author <login>]
```

Edit the printed `review.html`. Follow AGENTS.md: one-paragraph summary, one `<rr-flow>` delta
diagram (baseline vs new), sections in tracing order, every claim linked with `rr:code/…#L` refs
(verify line numbers against the head revision), `<rr-code ref>` instead of pasted code,
`<rr-callout kind="risk">` for real risks, an `<rr-checklist>` at the end. Add interactive widgets
with `window.rr` when they genuinely help (latency budgets, data shapes, state machines).

## 3. Hand over and wait

```bash
readingroom review
```

This opens the browser and blocks until the reviewer clicks **Send feedback** or **Approve**, then
prints the feedback (markdown) and exits. Run it in the foreground; do not background it.

## 4. Answer the round

For each thread in the printed feedback:

- `readingroom reply <thread-id> "<markdown>"` — answer precisely; link instead of repeating
  (`[label](rr:code/path#L1-5)`, `![](rr:doc/<section-id>)` on its own line embeds a preview).
- Substantial answers (tables, diagrams, queries, sketches) go into a **new section** in
  `review.html` marked `data-round="<next round>"`; the reply links/embeds it.
- `--resolve` only when the point is fully addressed. Never resolve the reviewer's open questions silently.
- If the reviewer asked for code changes, make them, then update the narrative's links.

Then run `readingroom review` again. Repeat until the reviewer approves.

## Useful

- `readingroom threads` (open threads), `readingroom status`, `readingroom comment <rr-ref> "<md>"`.
- `--head worktree` reviews uncommitted changes.
- Everything lives in `.readingroom/<branch>/` (git-excluded): `review.html`, `state.json`,
  `rounds/<n>/feedback.md` and the narrative snapshot of every round.
