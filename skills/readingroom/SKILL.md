---
name: readingroom
description: Run agent-guided code reviews in readingroom, a local review workbench where you write a linked, interactive narrative of a PR next to its live diff and answer the reviewer's comment threads round by round. Use this whenever the user wants a PR, branch or diff reviewed or explained "in readingroom", asks for a guided/walkthrough review of a change, gives a PR number or GitHub PR URL to review, says they left comments or sent feedback in readingroom, or asks you to reply to review threads, even if they don't name the tool.
---

# readingroom

readingroom is a review workbench that runs locally in the browser. You (the agent) write the
**narrative**: an HTML page explaining a change, where every claim links to the real code. The tool
puts that next to the **live diff of the local clone** and gives the reviewer everything around it:
docking panels, file tree, contents, symbol search, comments anchored to any sentence, block, element
or code line, and **rounds** of feedback between reviewer and agent.

The reviewer reads fast and jumps constantly between explanation and code. Your narrative is worth
writing only if it makes that jump effortless and never asks them to trust you without a link.

## Quick start

```bash
readingroom pr 4821 --repo ~/Codes/<project> --detach      # number, PR URL, or branch name
```

This fetches the PR (uses `gh` for title/base/author when it is logged in), scaffolds
`<repo>/.readingroom/pr-4821/review.html`, starts the server in the background and prints its URL.
The page live-reloads whenever you save `review.html`. `readingroom status --json --dir <dir>`
gives you base/head shas, the review path, the URL and open threads at any time.

If `readingroom` is not on PATH, run it from its repo: `node <readingroom>/cli/readingroom.mjs …`
(or `mise run setup` there once).

## Workflow

1. **Understand the change.** Use git on the printed base/head (`git diff <base>...<head> --stat`,
   then the files). Find the entry point, the new pieces, storage/proto/config changes, failure paths
   and what the tests cover. Read the PR description if `gh` is available.
2. **Write `review.html`.** Freeform HTML inside `<rr-review>`; follow `references/review-craft.md`
   for what to say and in what order, and `references/authoring.md` for the building blocks
   (`rr:` links, `<rr-flow>`, `<rr-code>`, `<rr-callout>`, `<rr-checklist>`, `window.rr`, theming).
   Verify every line number you cite against the head revision; a wrong link is worse than none.
3. **Hand over.** Tell the user the URL. When they want to review with you in the loop, run
   `readingroom review --dir <dir>` in the foreground: it takes over the server (same port, so the open
   tab reconnects) and **blocks** until they press *Send feedback* or *Approve*, then prints the
   feedback as markdown and exits.
4. **Answer the round.** For each thread in the feedback, see `references/cli.md`:
   reply with `readingroom reply <thread-id> "<markdown>"`; put substantial answers (tables,
   diagrams, queries, sketches) into a **new section** with `data-round="<next round>"` and link or
   embed it from the reply instead of repeating it; `--resolve` only when fully addressed; change code
   if asked. Then run `readingroom review` again for the next round.
5. **Finish.** `readingroom stop --dir <dir>` when the review is over (approval also ends the loop).

## What the reviewer can do (so you can design for it)

- Jump from any `rr:` link to the exact lines; see split/unified diffs, whitespace-insensitive diffs,
  only-new or only-old code, the whole file before/after, any single commit.
- Comment on a text selection, a whole block (paragraph, table, diagram, widget) or any element, a
  code line range, or the PR in general. Threads show as highlights + margin chips and open in a
  markdown popup that can be docked.
- Rearrange everything: dock, float, stack and split panels; presets for reading, wide code, code
  focus and narrative focus; light and dark themes; ⌘K palette with `#` symbol and `/` code search.
- Toggle "baseline" blocks, sign off checklist items, pin sections, mark files viewed.

Because of this, structure the narrative as **short, commentable sections** with stable ids, and make
every diagram node and widget part clickable into the code. Layout and tooltips are the reviewer's;
you shape the review through content, links and (optionally) theme tokens.

## References

- `references/review-craft.md`: what a worthwhile review looks like for this reviewer; read before writing.
- `references/authoring.md`: HTML conventions, `rr:` link grammar, helper elements, `window.rr`, theming.
- `references/cli.md`: every command, the round loop, the feedback format, where state lives.
