# Review rounds: server, feedback and replies

This round loop is for external agents. The built-in assistant follows the conversation in its panel.

## Wait for the reviewer

`reviewroom wait <review>` (from `pr`'s or `reply`'s `help:` lines, or `reviewroom` for running
reviews) starts the server if needed and exits with the next round. Run it in the background.
**Do NOT proceed until it exits**, do not ask the reviewer to type anything, and do not poll threads
to tell whether the round is finished. If the reviewer asks for status, run `reviewroom status
<review>` without treating that as the end of the round. Stop the review only when asked.

## Read the feedback

The command prints the round's feedback as markdown: one block per thread with new messages, each
with its anchor, then the state of the flagged questions in the report, under
`Flagged questions`, and the reviewer's overall note. Its opening lines give the
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
5. Reply with `reviewroom reply <review> <thread-id> --file <reply.md>`; its output says what is left.
6. Leave resolving to the reviewer unless they ask.
7. **The round is not over until you do what the last `reply` prints**: `check` if the report changed,
   then `wait` in the background, then tell the reviewer the replies are in.

After edits, follow [Validation and audit](validation-and-audit.md) again. For a PR
fetched from GitHub, the review's head is the PR as fetched when the review started: code you commit or
push is outside the diff the reviewer sees because a running server keeps the revision it opened.
When the reviewer reconnects after a restart with new commits, the page reloads to show the new diff.
Say so in the reply, and link the new code at your commit
(`rr:code/<path>@<sha>#L10-20`); `rr:sym` and plain `rr:code` links still resolve at the old head. For uncommitted work (`--head worktree`) your edits show up live.

A thread anchored on a walkthrough slide (`rr:tour/<chapter>/<step>`; its anchor line quotes
the slide) is about that slide. A short answer goes in the reply. When the reviewer wants more (a
deeper explanation, a table, a sketch), grow the report instead of the slide: a new `data-round`
section (under **Your questions** for someone else's PR) that embeds the slide
(`<rr-embed ref="rr:tour/<chapter>/<step>">`), links the thread at its top and expands on it. The reply
links that section, and the discussion continues there. Edit the slide itself only if it was wrong or misleading; keep its ids (threads are anchored to them) and loop
again using [Validation and audit](validation-and-audit.md) until clean.
