# Review rounds: server, feedback and replies

Read "Start the review server" before launching a review. After handover, follow the round loop
below. When answering feedback on an existing review, begin with "Resume an existing review".

## Start the review server

**CRITICAL: you MUST run this step. Do NOT skip it.**

```bash
reviewroom pr <target>
```

Run the `wait` command it prints in the background. The review opens in the macOS app when installed,
otherwise in the browser. Use `--browser` to open the browser. The server stays up between rounds.

## Resume an existing review

Run `reviewroom wait <target>` in the background from the reviewed repo or pass `--repo <path>`.
Use `--dir <dir>` for a custom folder. The command starts the server if needed and prints the next
unread round as soon as it is available.

## Check status and stop

Use `reviewroom status <target> --json` for the URL, review directory, base/head shas and status;
add `--threads` when the reviewer asks about the threads. Do not use thread polling as a substitute
for the round command's completion. To end the review when asked, run `reviewroom stop <target>`.

## Wait for the reviewer

**Do NOT proceed until the background command exits.** Do NOT ask the reviewer to type anything. Do not
poll threads to determine whether the round is finished. If the reviewer explicitly asks for status,
inspect it without treating that request as the end of the round. The command exiting is how you
know the reviewer has finished the round.

## Read the feedback

The command prints the round's feedback as markdown: one block per thread with new messages, each
with its anchor, then the state of the flagged questions in the report, under
`Open questions`, and the reviewer's overall note. Its opening lines give the
exact commands to answer and to start the next round.

If its heading says `APPROVED`, tell the reviewer and stop. Leave open threads alone unless they ask.

<important if="a thread's anchor points at code or report text that has changed since">
The anchor is what the thread is about. A code anchor carries the excerpt the reviewer saw; a
report anchor carries the quoted text. Find the current position by that excerpt or quote, not
by line number.
</important>

## Answer each thread

For each thread in the feedback:

1. Understand what it asks. For someone else's PR, never change code, even if a later round asks
   for a fix: explain the suggested direction instead. Check the PR author against the authenticated
   `gh` login as in Step 3 of the skill. In other reviews, change code or the report if asked.
2. Short answers go in the reply. Substantial ones (tables, diagrams, queries, sketches) go in a new
   section of the report (under **Your questions** for someone else's PR), and the reply links to it.
   If the explanation already exists in the report, link that section instead.
3. Mark every section you add or substantially change with `data-round="<next round>"`, and link
   the thread that prompted it at the section's top.
4. When the answer builds on an earlier thread, a team thread or what the report said in an
   earlier round, link it (`rr:thread/<id>`, `rr:thread/gh_<n>`, `rr:round/<n>`) instead of
   restating it.
5. Reply with `reviewroom reply <thread-id> --file <reply.md> --dir <dir>`.
6. **Do not pass `--resolve`.** Resolving is the reviewer's call. Only resolve if the reviewer
   explicitly asks.

After edits, follow [Validation and audit](validation-and-audit.md) again. For a PR
fetched from GitHub, the review's head is the PR as fetched when the review started: code you commit or
push is not in the diff the reviewer sees until you refresh the target with `reviewroom pr <target>`
and restart its server with `stop` then `start`. Say so in the reply, and link the new code at your commit
(`rr:code/<path>@<sha>#L10-20`); `rr:sym` and plain `rr:code` links still resolve at the old head. For uncommitted work (`--head worktree`) your edits show up live.

A thread anchored on a walkthrough slide (`rr:tour/<chapter>/<step>`; its anchor line quotes
the slide) is about that slide. A short answer goes in the reply. When the reviewer wants more (a
deeper explanation, a table, a sketch), grow the report instead of the slide: a new `data-round`
section (under **Your questions** for someone else's PR) that embeds the slide
(`<rr-embed ref="rr:tour/<chapter>/<step>">`), links the thread at its top and expands on it. The reply
links that section, and the discussion continues there. Edit the slide itself only if it was wrong or misleading; keep its ids (threads are anchored to them) and loop
again using [Validation and audit](validation-and-audit.md) until clean.

<important if="you are replying to several threads at once">
Write the answers to a JSON file, then send them in one call (all or nothing):
`reviewroom reply --json <replies.json> --dir <dir>`, with `[{"thread": "t_ab12", "body": "…"}]`.
</important>

<important if="the feedback lists threads under 'Open on GitHub'">
Those are team threads: colleagues' threads on the PR, shown for context. They are not feedback for you and you
cannot reply to them. When one matters to your answer, link or embed it with `rr:thread/gh_<n>`.
</important>

## Start the next round

**CRITICAL: you MUST run this step. Do NOT skip it.**

Run the command the feedback names **in the background**:

```bash
reviewroom wait <target>
```

Tell the reviewer: **"Replies are in. Review them in the browser and click Send feedback or Approve
when ready."** Then wait for the reviewer again.
