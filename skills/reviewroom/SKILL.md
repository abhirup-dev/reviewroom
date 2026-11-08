---
name: reviewroom
description: Run agent-guided code reviews in reviewroom, a local review workbench where you write an interactive walkthrough of a diff (a PR, branch or uncommitted work) next to the live code, optionally a guided walkthrough (chaptered slides played over the code), and answer the reviewer's threads round by round.
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
`bunx reviewroom …`. This skill covers the usual path; `reviewroom --help` lists every capability
(screenshots, the hub, …).

## Choose the command

| The reviewer wants                                        | Run                                                                  |
| ---                                                       | ---                                                                  |
| A review of a GitHub PR (number or URL) or a local branch | `reviewroom pr <n \| url \| branch> --repo <path> --wait` → Step 1   |
| A review of uncommitted work                              | `reviewroom pr --head worktree --repo <path> --wait` → Step 1        |
| You to answer feedback they already sent                  | Read `references/review-rounds.md`, "Resume an existing review"      |
| To see where a review stands                              | `reviewroom status --json --dir <dir>` (`--threads` for the threads) |
| To end the review                                         | `reviewroom stop --dir <dir>`                                        |

## Step 1: Start the review in the background

Read "Start the review server" in `references/review-rounds.md` and launch the review as it
instructs. Keep the command running in the background while writing the walkthrough.

## Step 2: Relay the URL

The command's first lines name the review directory (`~/.reviewroom/reviews/<owner>-<repo>/<branch>`,
outside the repo) and the URL.
`reviewroom status --json --dir <dir>` gives both again, plus the base/head shas. Relay the URL
verbatim:

> **"reviewroom is open at http://127.0.0.1:<port>/. I'm writing the walkthrough now; it updates live."**

## Step 3: Understand the diff

Read `git diff <base>...<head> --stat`, then the files. Use the shas from `reviewroom status --json`,
not your checkout: every line number you link is the head sha's, so read files with
`git show <head>:<path>`. For uncommitted work (`--head worktree`) the head is the literal `worktree`:
run `git diff <base> --stat`, read files from disk, and add untracked files
(`git ls-files --others --exclude-standard`), which `git diff` leaves out. Find the entry point, the new pieces,
storage / proto / config changes, failure paths and what the tests cover. Read the PR description
when `gh` is available.

**Take line numbers from ast-grep, not by counting.** A range that is off by a few lines cuts a
function in half or highlights the wrong statement, and the reviewer has to fix it. Pipe the head
revision in:

```bash
git show <head>:<path> | ast-grep outline --stdin --lang <lang>             # each declaration and its first line
git show <head>:<path> | ast-grep outline --stdin --lang <lang> --json=stream  # with end lines (0-based: add 1)
git show <head>:<path> | ast-grep run --stdin --lang <lang> -p '<pattern>'   # a call or statement by shape
```

For `--head worktree`, pass the file path instead of piping (`ast-grep outline <path>`).

reviewroom's setup installs `ast-grep` (the `ast-grep` skill, when installed, has the pattern
syntax). To show a whole declaration, `rr:sym/<name>` needs no numbers.

**Decide on a guided walkthrough now.** A guided walkthrough (`walkthrough.json` next to
`review.html`) is the main story of the diff played over the workbench: chapters of slides, narration on
the left, the slide's code on the right. When there is one, the reviewer opens it first, so it tells the
main story; the walkthrough (`review.html`) is where they dig in.

- Write one when the reviewer asked for a guided walkthrough, guided review or tour.
- If they didn't, and the diff has a path to follow across files or touches more than about five,
  ask once: **"Want a guided walkthrough of this diff too?"** Don't wait for the answer: go on with
  the walkthrough, and write the guided walkthrough (Step 4b) if the answer is yes.

## Step 4: Write the walkthrough

Before writing, read:
1. `references/review-craft.md`: what to say and in what order (with a guided walkthrough,
   `references/guided-walkthrough-craft.md` first: outline the story once, then write both from it).
2. `references/authoring.md`: links, symbols, code previews and typography;
   `references/visual-formats.md` when choosing or writing visuals.

The walkthrough is usually read in a narrow side panel (about 400px) or on a phone: design every
diagram, table and widget for that width, never for a wide page.

Reviewroom has good support for rich visualizations in Mermaid; leverage it.

Edit `review.html` in the review directory; the open page reloads on every save. Then run
`reviewroom check --fix --dir <dir>` and fix whatever it still reports.
Optionally, to see it as the reviewer will (or to fix a layout problem they report), run
`reviewroom shot [section] --dir <dir>`: PNGs of the Review panel, one per section, no browser needed.

## Step 4b: Write the guided walkthrough, when wanted

Read `references/guided-walkthrough-craft.md` (the shape: context, threads, convergence on the critical
files, reconciliation; the diff and description as the only evidence), then "Guided walkthrough" in
`references/authoring.md` (the file and its checks). Write `walkthrough.json`, then run those checks
until clean. Each finding names the chapter/step and how to fix it. Take a screenshot only of slides
you need to see.

## Step 4c: Hand over

Only once the walkthrough (and the guided walkthrough, if wanted) is done and clean, tell the reviewer:

- With a guided walkthrough: **"The review is ready. Start with the guided walkthrough:
  <url>?walkthrough= — then leave comments on slides or the walkthrough, and click Send feedback (or
  Approve)."** (`?walkthrough=` opens the player at the first slide; the page alone does not.)
- Without: **"The walkthrough is ready. Leave comments, then click Send feedback (or Approve)."**

## Step 5: Continue across review rounds

Read `references/review-rounds.md` for waiting on feedback, checking status, answering comments,
and starting the next round. Follow that loop until the reviewer approves or asks to stop.

## Do not

- Do not edit anything in the review directory except `review.html`, `walkthrough.json` and assets
  you add next to them.
- Do not refer to anything reviewroom can link (a code range, symbol, file, section, thread from
  any round, team thread, earlier round) in plain text, and do not paraphrase or quote a thread:
  link or embed it. Follow the link-placement guidance in `references/authoring.md`, under "Links: `rr:` refs".
- Do not paste diff code into the walkthrough or replies; link or embed it.
- Do not cite a line number you have not checked against the head revision (ast-grep, Step 3).
- Do not guess flags; run `reviewroom <command> --help`.
