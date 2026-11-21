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

The CLI guides you: `reviewroom` alone lists running reviews, every command ends with the next
commands to run (`help:`), and `reviewroom <command> --help` has its flags. If `reviewroom` is not on
PATH, use `bunx reviewroom …`.

## The review directory

`reviewroom pr` creates the review directory and, in it, the report from the review's report profile;
`pr` and `status` print both paths. You write only:

- The report (`report.html`): the long-form review, starting with the profile's sections.
- The walkthrough (`walkthrough.json`): the chaptered slides.
- Assets (images, CSS, JS) beside the report, referenced relatively.

Everything else in it belongs to reviewroom: don't edit it.

## Built-in or external agent

If `REVIEWROOM_ASSISTANT_DIR` is set, you are the assistant inside an already running review.
`reviewroom status "$REVIEWROOM_ASSISTANT_DIR"` confirms `role: assistant`, the URL and the frozen
revisions. Pass that directory as the target for every review command.
Do not start, stop or restart this review's server, run `pr`, or wait for feedback rounds:
your conversation in the assistant panel is the feedback channel. Answer the current question; when
asked to author, follow Steps 3–4b and their references, then report the result in the conversation.
Read `status` again if the review advances. Learn authoring through this skill, its references and
CLI help; you do not need Review Room's implementation source.

Without that marker, follow the external-agent workflow below, including starting the server and
continuing across rounds. Both routes use the same authoring rules and validation references.

## Steps 1–2: Start the review and relay the URL

Run `reviewroom pr 'acme/api#31'` (a PR's quoted Review ID or URL, or a branch; `--head worktree` for
uncommitted work), from the checkout or with `--repo <path>`. Run `reviewroom` alone to see reviews
already running. Do what its `help:` lines say: start `wait` (as a background task if your shell reports
when such tasks exit; otherwise in the foreground once you finish writing, never with `&`: see
`references/review-rounds.md`, "How to run `wait`"), and tell the reviewer
the URL verbatim: **"reviewroom is open at <url>. I'm writing the walkthrough first."**
`--profile <name>` picks the report profile (default `explainer`; see `references/profiles/index.md`).
Stop a review only when the reviewer explicitly asks.

## Step 3: Understand the diff

Read `git diff <base>...<head> --stat`, then the files. Use the `base` and `head` that `pr` and
`status` print, not your checkout: every line number you link is the head sha's, so read files with
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
4. Run a full `reviewroom slide-lint <review>` and follow its output until it passes. The reviewer
   sees a loading screen until a full run passes. See [Validation and audit](references/validation-and-audit.md).

## Step 4b: Fill the report

Only after the walkthrough passes, fill the report's sections as the profile's guide says.
Keep their ids; the HTML inside is yours.

The walkthrough tells the story; the report keeps the detailed review and later answers.
They need not mirror each other. Both are read in a narrow panel (about 400px) or on a phone:
design every diagram, table and widget for that width. Prefer Mermaid for diagrams.

Run `reviewroom check <review> --fix` and follow its output until it passes; it then prints the
hand-over message for the reviewer.

## Step 5: Continue across review rounds

When `wait` exits, read `references/review-rounds.md` and answer the round. Repeat until the
reviewer approves or asks to stop.

## Do not

- Do not edit anything in the review directory except the report, the walkthrough and assets you add
  next to them.
- Do not refer to anything reviewroom can link (a code range, symbol, file, section, thread from
  any round, team thread, earlier round) in plain text, and do not paraphrase or quote a thread:
  link or embed it. Follow the link-placement guidance in `references/authoring.md`, under "Links: `rr:` refs".
- Do not paste diff code into the report or replies; link or embed it.
- Do not cite a line number you have not checked against the head revision (ast-grep, Step 3).
- Do not guess flags: an unknown one fails and lists the valid ones.
