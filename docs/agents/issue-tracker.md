# Issue tracker: Beads

Issues and specs for this repo live in Beads, a local issue tracker with first-class dependencies. Use the `bd` CLI
for all operations. The database sits in the main checkout's `.beads/` and is shared by every worktree; `bd context`
shows which one is in use.

## Conventions

- **Create an issue**: `bd create "<title>" -t <bug|feature|task|epic|chore|spike> -d "..."`. For multi-line bodies,
  use `--body-file -` with a heredoc. Add `-l <labels>`, `--parent <id>` and `--deps blocked-by:<id>` as needed.
- **Read an issue**: `bd show <id>` (`bd show <id> --json --include-comments` for comments).
- **List issues**: `bd list --json` with `--status open,in_progress`, `--label <label>` (AND) or `--label-any` (OR)
  filters.
- **Comment on an issue**: `bd comment <id> "..."`
- **Apply / remove labels**: `bd update <id> --add-label <label>` / `--remove-label <label>`
- **Close**: `bd close <id> --reason "..."`

## When a skill says "publish to the issue tracker"

Create a bead with `bd create`.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic with **child** beads as tickets.

- **Map**: an epic labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
  `bd create "<title>" -t epic -l wayfinder:map`.
- **Child ticket**: `bd create "<title>" --parent <map-id> -l wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: native Beads dependencies. `bd dep add <child> <blocker>` (the child depends on the blocker).
- **Frontier query**: `bd ready --parent <map-id> --json` lists open, unblocked, unclaimed children; first in map order
  wins.
- **Claim**: `bd update <id> --claim` (sets you as assignee and status `in_progress`), the session's first write.
- **Resolve**: `bd comment <id> "<answer>"`, then `bd close <id>`, then append a context pointer (gist + id) to the
  map's Decisions-so-far.
