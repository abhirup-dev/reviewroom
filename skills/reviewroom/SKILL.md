---
name: reviewroom
description: Run agent-guided code reviews in reviewroom, a local review workbench where you write a linked, interactive walkthrough of a diff (a PR, branch or uncommitted work) next to the live code and answer the reviewer's threads round by round. Use this whenever the user wants a PR, branch or diff reviewed or explained "in reviewroom", asks for a guided/walkthrough review of a change, gives a PR number or GitHub PR URL to review, says they left comments or sent feedback in reviewroom, or asks you to reply to review threads, even if they don't name the tool.
---

# Review with reviewroom

reviewroom is a local, browser-based code review workbench. You write the **walkthrough**: an HTML
page that explains the **diff** under review, where every claim links to the real code. reviewroom
shows it next to the live diff of the local clone. The **reviewer** (the person reviewing, who may
also be the PR's author) starts threads on any sentence, block or code line, and at the end of each
**round** sends you their **feedback**; you answer, and the next round begins. Every thread, reply,
open question and round is kept from one round to the next.

The CLI's help is the command reference: `reviewroom --help`, and `reviewroom <command> --help`
for flags and notes. Read it before your first command. If `reviewroom` is not on PATH, use
`npx -y reviewroom …`.

## Choose the command

| The reviewer wants | Run |
| --- | --- |
| A review of a GitHub PR (number or URL) or a local branch | `reviewroom pr <n \| url \| branch> --repo <path> --wait` → Step 1 |
| A review of uncommitted work | `reviewroom pr --head worktree --repo <path> --wait` → Step 1 |
| You to answer feedback they already sent | `reviewroom review --dir <dir>`: prints unread feedback at once → Step 6 |
| To see where a review stands | `reviewroom status --json --dir <dir>` (`--threads` for the threads) |
| To end the review | `reviewroom stop --dir <dir>` |

## Step 1: Start the review in the background

**CRITICAL: you MUST run this step. Do NOT skip it.**

Run it **in the background** (`run_in_background: true`):

```bash
reviewroom pr <n | url | branch> --repo <path> --wait
```

It creates the review, serves it, opens the browser, and then blocks until the reviewer clicks
*Send feedback* or *Approve*. That can take hours. In Claude Code, a background command is stopped
after 30 minutes unless you also pass a longer `timeout` (up to `7200000` ms). If it is stopped by a
time limit, run `reviewroom review --dir <dir>` in the background: nothing is lost (re-running
`pr` would fetch the PR again and could move the head mid-round).

The page goes offline when the command exits and comes back with the next one; the reviewer's open
tab reconnects by itself. That is expected.

## Step 2: Relay the URL

The command's first lines name the review directory (`.reviewroom/pr-<n>` for a PR) and the URL.
`reviewroom status --json --dir <dir>` gives both again, plus the base/head shas. Relay the URL
verbatim:

> **"reviewroom is open at http://127.0.0.1:<port>/. I'm writing the walkthrough now; it updates live."**

## Step 3: Understand the diff

Read `git diff <base>...<head> --stat`, then the files. Find the entry point, the new pieces,
storage / proto / config changes, failure paths and what the tests cover. Read the PR description
when `gh` is available.

## Step 4: Write the walkthrough

Before writing, read:
1. `references/review-craft.md`: what to say and in what order.
2. `references/authoring.md`: links, symbols, code previews, diagrams, typography.

Edit `review.html` in the review directory; the open page reloads on every save. Then run
`reviewroom check --fix --dir <dir>` and fix whatever it still reports.

Tell the reviewer: **"The walkthrough is ready. Leave comments, then click Send feedback (or Approve)."**

## Step 5: Wait for the reviewer

**Do NOT proceed until the background command exits.** Do NOT ask the reviewer to type anything. Do NOT
read threads early. The command exiting is how you know the reviewer has finished the round.

## Step 6: Read the feedback

The command prints the round's feedback as markdown: one block per thread with new messages, each
with its anchor (`narrative` there means the walkthrough), then the state of the walkthrough's open
questions (under `Sign-off checklist`) and the reviewer's overall note. Its opening lines give the
exact commands to answer and to start the next round.

If its heading says `APPROVED`, tell the reviewer and stop. Leave open threads alone unless they ask.

<important if="a thread's anchor points at code or walkthrough text that has changed since">
The anchor is what the thread is about. A code anchor carries the excerpt the reviewer saw; a
walkthrough anchor carries the quoted text. Find the current position by that excerpt or quote, not
by line number.
</important>

## Step 7: Answer each thread

For each thread in the feedback:

1. Understand what it asks. Change code or the walkthrough if asked.
2. Short answers go in the reply. Substantial ones go in a new section of `review.html`, and the
   reply links to it (see "Answering threads" in `references/review-craft.md`).
3. Mark every section you add or substantially change with `data-round="<next round>"`, and link
   the thread that prompted it at the section's top.
4. When the answer builds on an earlier thread, a team thread or what the walkthrough said in an
   earlier round, link it (`rr:thread/<id>`, `rr:thread/gh_<n>`, `rr:round/<n>`) instead of
   restating it.
5. Reply with `reviewroom reply <thread-id> --file <reply.md> --dir <dir>`.
6. **Do not pass `--resolve`.** Resolving is the reviewer's call. Only resolve if the reviewer
   explicitly asks.

If you changed code, run `reviewroom check --fix --dir <dir>` again and fix what it reports.

<important if="you are replying to several threads at once">
Write the answers to a JSON file with the Write tool, then send them in one call (all or nothing):
`reviewroom reply --json <replies.json> --dir <dir>`, with `[{"thread": "t_ab12", "body": "…"}]`.
</important>

<important if="the feedback lists threads under 'Open on GitHub'">
Those are team threads: colleagues' threads on the PR, shown for context. They are not feedback for you and you
cannot reply to them. When one matters to your answer, link or embed it with `rr:thread/gh_<n>`.
</important>

## Step 8: Start the next round

**CRITICAL: you MUST run this step. Do NOT skip it.**

Run the command the feedback names, **in the background** as in Step 1:

```bash
reviewroom review --dir <dir>
```

Tell the reviewer: **"Replies are in. Review them in the browser and click Send feedback or Approve
when ready."** Then return to Step 5.

## Do not

- Do not run `reviewroom pr --wait` or `reviewroom review` in the foreground; they block until the
  reviewer acts. Never run `reviewroom pr` without `--wait` or `--detach`: it serves forever.
- Do not stop or kill the background command to "finish" a round; wait for it to exit.
- Do not pass `--resolve` unless the reviewer explicitly asks.
- Do not edit anything in the review directory except `review.html` and assets you add next to it.
- Do not refer to anything reviewroom can link (a code range, symbol, file, section, thread from
  any round, team thread, earlier round) in plain text, and do not paraphrase or quote a thread:
  link or embed it. Link a thing where it first comes up; when the same thing appears again within
  the next few paragraphs (roughly 10 to 15 lines), plain mention is fine. Don't repeat links.
- Do not paste diff code into the walkthrough or replies; link or embed it.
- Do not cite a line number you have not checked against the head revision.
- Do not guess flags; run `reviewroom <command> --help`.
