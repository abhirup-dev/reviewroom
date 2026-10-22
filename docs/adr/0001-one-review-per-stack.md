# One review per stack of PRs, in `stack-<id>/`

A review is keyed by its branch: `~/.reviewroom/reviews/<owner>-<repo>/<branch>/`, a PR's head branch, never `pr-<n>`
(rr-b5o). A stack of PRs (each PR's base the head of the PR below) is reviewed as one review: its walkthrough, threads
and rounds cover every PR, and the reviewer scopes the diff to the whole stack or one PR's layer. Keyed by branch, `pr 367`
and `pr 368` on one stack would make two reviews, and the key would change as the stack grows on top, its bottom PR
merges, or a PR is retargeted.

So a stack's review lives in `stack-<id>/`, where the id is GitHub's native stack number, else the bottom PR's number,
taken at first detection. `reviewroom pr <n>` first looks for a review whose `config.json` stack shares a PR with the one
just detected, and reuses its dir: the same review whichever member it was opened from, and after the id changes (the
bottom PR merged and dropped out of the chain). Commands run without `--dir` (`status`, `reply`, ...) find it from any
member's branch: when the current branch has no review of its own, the repo's review of a stack with a PR from that
branch is used.

This departs from "the name is always the branch" for stacks only; a PR outside a stack, a local branch, and
`pr <n> --no-stack` are still keyed by branch.

## Considered

- **The bottom PR's head branch.** Stays a branch name and stable while the stack grows on top, but misleading once
  the bottom PR merges, and a squash-merged bottom often has its branch deleted.
- **The requested PR's branch, plus a lookup.** Opening the stack from another member would make a second review
  unless the lookup ran first; the name would depend on where the reviewer happened to start.

## Consequences

- The lookup reads every `config.json` under the repo's reviews dir (cheap: a handful of files, rr-b5o).
- A local stack of branches (`pr <branch>`, no PRs) is keyed by the branch named, as before: its top. Naming a lower
  branch reviews the stack up to it; adding a branch on top makes a new review. Its layers are numbered 1..n bottom
  first (not by PR: a real PR's number could equal another layer's position), so it has no GitHub side.
- Left open: a PR that leaves its stack, or two stacks that merge, keep the review they had; a single-PR review of a
  member made before stacks is not adopted into the stack's review.
