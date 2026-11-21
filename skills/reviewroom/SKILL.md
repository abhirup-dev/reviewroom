---
name: reviewroom
description: Run agent-guided code reviews in reviewroom, a local review workbench where you write a walkthrough of a diff (a PR, branch or uncommitted work: chaptered slides played over the live code), a report beside it, and answer the reviewer's threads round by round.
---

# Review with reviewroom

reviewroom is a local, browser-based code review workbench. You write the **report**: an HTML
page that explains the **diff** under review, where every claim links to the real code.
reviewroom shows it next to the live diff of the local clone. The **reviewer** (the person reviewing, who may
also be the PR's author) starts threads on any sentence, block or code line, and at the end of each
**round** sends you their **feedback**; you answer, and the next round begins. Every thread, reply,
flagged question and round is kept from one round to the next.

The CLI's help is the command reference: `reviewroom --help`, and `reviewroom <command> --help`
for flags and notes. Read it before your first command. If `reviewroom` is not on PATH, use
`bunx reviewroom …`. This skill covers the usual path; `reviewroom --help` lists every capability
(screenshots, the hub, …).

## The review directory

`reviewroom pr` creates the review directory and, in it, the report from the review's report profile.
`reviewroom status 'acme/api#31' --json` gives the directory and the report's path. You write only:

- The report (`report.html`): the long-form review, starting with the profile's sections.
- The walkthrough (`walkthrough.json`): the chaptered slides.
- Assets (images, CSS, JS) beside the report, referenced relatively.

Everything else in it belongs to reviewroom: don't edit it.

## Built-in or external agent

If `REVIEWROOM_ASSISTANT_DIR` is set, you are the assistant inside an already running review.
Run `reviewroom status "$REVIEWROOM_ASSISTANT_DIR" --json` to confirm `role: "assistant"`,
the review directory, URL and frozen revisions. Pass that directory as the target for every review command.
Do not start, stop or restart this review's server, run `pr`, or wait for feedback rounds:
your conversation in the assistant panel is the feedback channel. Answer the current question; when
asked to author, follow Steps 3–4b and their references, then report the result in the conversation.
Read `status` again if the review advances. Learn authoring through this skill, its references and
CLI help; you do not need Review Room's implementation source.

Without that marker, follow the external-agent workflow below, including starting the server and
continuing across rounds. Both routes use the same authoring rules and validation references.

## Choose the command (external agent)

| The reviewer wants                                        | Run                                                                  |
| ---                                                       | ---                                                                  |
| A review of a GitHub PR (number or URL) or a local branch | `reviewroom pr 'acme/api#31'` (or `pr <branch>`) → Step 1                                    |
| A review of uncommitted work                              | `reviewroom pr <branch> --head worktree` → Step 1                             |
| You to answer feedback they already sent                  | Read `references/review-rounds.md`, "Resume an existing review"      |
| To see where a review stands                              | `reviewroom status 'acme/api#31' --json` (`--threads` for the threads)    |
| To end the review                                         | `reviewroom stop 'acme/api#31'`                                           |

Pass a target immediately after each review command. Use the PR's quoted Review ID (`'owner/repo#n'`,
with the base repository for forks) or its URL. An existing PR review can be reached from any directory.
To create one, run `pr` from its checkout or pass `--repo <path>`. Only `pr` accepts a bare PR number.
For a local review, use its branch from the checkout (or pass `--repo <path>`) or pass an existing
review folder as an absolute or `./`-relative path. Stop a review only when the reviewer explicitly asks.

## Step 1: Start the review

Run `pr`, then the printed command (for example, `reviewroom wait 'acme/api#31'`): as a background task while you write the walkthrough and the report if your shell reports when such tasks exit; otherwise in the foreground once you finish writing, never with `&` (`references/review-rounds.md`, "How to run `wait`").
The detached server stays up between rounds. See `references/review-rounds.md`.
`--profile <name>` picks the report profile (default `explainer`; see `references/profiles/index.md`).

## Step 2: Relay the URL

`pr` prints the review directory outside the repo and the URL.
`reviewroom status 'acme/api#31' --json` gives both again, plus the base/head shas. Relay the URL
verbatim:

> **"reviewroom is open at http://127.0.0.1:<port>/. I'm writing the walkthrough first."**

## Step 3: Understand the diff

Read `git diff <base>...<head> --stat`, then the files. Use the shas from `reviewroom status 'acme/api#31' --json`,
not your checkout: every line number you link is the head sha's, so read files with
`git show <head>:<path>`. For uncommitted work (`--head worktree`) the head is the literal `worktree`:
run `git diff <base> --stat`, read files from disk, and add untracked files
(`git ls-files --others --exclude-standard`), which `git diff` leaves out. Find the entry point, the new pieces,
storage / proto / config changes, failure paths and what the tests cover. Read the PR description
when `gh` is available. For a PR, compare `gh pr view <n | url> --json author --jq .author.login`
with `gh api user --jq .login` from the repo. If they differ, explain and review only: **never change
code, including in later rounds**. If ownership is unknown, establish it before changing code.

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

## Step 4: Outline, then write the walkthrough first

Read `references/walkthrough-craft.md` for the story, `references/report-craft.md` for the
record, `references/profiles/index.md`, and the guide of the review's report profile. Read
`references/authoring.md` for the format and `references/visual-formats.md` when writing visuals.
The report already has its sections, from the profile.

Always provide a walkthrough. If `reviewroom pr` pulled one shipped with the PR, use it as is;
it was validated before publication. Go to Step 4b without replacing it. Otherwise:

1. Once you have read the diff, record it: `reviewroom progress <review> read`.
2. Outline the intro, the story and a final **Risks** chapter. Use fewer slides for small diffs.
   Each main risk is one line with a severity and an `rr:doc/<section id>` link to its finding in
   the report; keep detailed findings out of the slides. For each risk, add a heading-only finding
   section under Findings in the report, with a stable id for the link.
3. Write the walkthrough.
4. Run a full `reviewroom slide-lint <review>`, fix issues and repeat until it passes.
   The reviewer sees a loading screen until a full run passes; scoped runs are for iterating and
   do not count. Follow [Validation and audit](references/validation-and-audit.md).

Use Download in the live desktop walkthrough player, or run `reviewroom export <review>`.
Both default to the slugged review ID and walkthrough title. Use `--out <path>` to name the CLI output.
The recipient can open the HTML directly in a browser. The file includes the full source of the files the
walkthrough shows. Export requires committed base and head revisions. The CLI checks for stale links by default.

## Step 4b: Fill the report

Only after the walkthrough passes, fill the report's sections as the profile's guide says.
Keep their ids; the HTML inside is yours.

The walkthrough tells the story; the report keeps the detailed review and later answers.
They need not mirror each other. Both are read in a narrow panel (about 400px) or on a phone:
design every diagram, table and widget for that width. Prefer Mermaid for diagrams.

Run `reviewroom check <review> --fix`, fix remaining issues and repeat until it passes.

## Step 4c: Hand over

Once both documents are done and clean, tell the reviewer:

> **"The review is ready. Start with the walkthrough: <url>?walkthrough= — then leave
> comments on slides or the report, and click Send feedback (or Approve)."**

`?walkthrough=` opens the player at the first slide.

## Step 5: Continue across review rounds

Use `reviewroom list` to find running reviews.
Read `references/review-rounds.md` for waiting on feedback, checking status, answering comments,
and starting the next round. Follow that loop until the reviewer approves or asks to stop.

## Do not

- Do not edit anything in the review directory except the report, the walkthrough and assets you add
  next to them.
- Do not refer to anything reviewroom can link (a code range, symbol, file, section, thread from
  any round, team thread, earlier round) in plain text, and do not paraphrase or quote a thread:
  link or embed it. Follow the link-placement guidance in `references/authoring.md`, under "Links: `rr:` refs".
- Do not paste diff code into the report or replies; link or embed it.
- Do not cite a line number you have not checked against the head revision (ast-grep, Step 3).
- Do not guess flags; run `reviewroom <command> --help`.
