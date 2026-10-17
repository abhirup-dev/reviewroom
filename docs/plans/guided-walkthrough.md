# Guided walkthrough: plan

Beads: `rr-d96` (epic) and its children. Mockup: `docs/plans/guided-walkthrough-mockup.html` (open it in a browser; everything in the player works).

## What it is

A chaptered, step-by-step tour of a PR. The agent writes one small `walkthrough.json`; reviewroom plays it as an overlay over the workbench: narration on the left, the step's code on the right, prev/next, chapter menu, progress. Pause shrinks the player to a pill so the reviewer can dig into the normal workbench and resume at the same step. The reviewer can comment on a step; the thread goes through the normal feedback round. The file is shareable through the PR, so a PR author can ship a walkthrough with their change and a reviewer's reviewroom plays it.

Plannotator has "Guided Review" (ordered sections with summaries next to live diffs) and "Code Tour" (narrated checkpoints). Ours differs in being an overlay over a full workbench, in commenting on steps through the existing rounds, and in being a file the author can attach to the PR.

## Decisions (settled in the design interview, do not relitigate)

| Question | Decision |
|---|---|
| Separate artifact or narrative play mode | Separate artifact: `walkthrough.json` next to `review.html` |
| Format | JSON with a Zod schema; prose fields are narrative HTML (same tokens: `<a href="rr:…">`, `<rr-flow>`, `<rr-code>`) |
| Chapter model | Chapter = `lead` (static HTML, may hold a diagram) + ordered `steps`; each step has its own `text` and an optional `ref` |
| Step without `ref` | Right pane keeps the last target; if the chapter lead has an `<rr-flow>`, show that diagram instead |
| Player | Overlay over the workbench (scrim). Pause = pill bottom-right, workbench fully usable, resume returns to the same step |
| Comments | "Comment on this step" opens the usual composer, anchor `{ kind: 'tour', chapter, step }`. Thread lives in the Threads panel and the feedback round; the step shows a badge. Threads do not render inside the slide |
| Autoplay | Not in v1. The machine leaves room (a `playing.auto` substate later) |
| Sharing | Fenced ` ```reviewroom-walkthrough ` block in a PR comment or description. `reviewroom pr` pulls it; `reviewroom walkthrough publish` posts it |
| Validation | `reviewroom check` validates the schema and every ref (step `ref` and links in prose) with the existing stale-link machinery. Deep link `/?walkthrough=<chapter>/<step>` lets any screenshot tool capture a step |
| Stacked PRs | Out of scope. Reserve: a chapter may later carry `pr: <n>`; refs may later take `@pr:<n>`. Do not build |
| Libraries | XState (already in), @pierre/diffs CodeView (already in). No new dependencies |
| Fidelity | CSS transitions only (fade/slide on step change, highlight glide within a file). No animation DSL |

## The format

`<review dir>/walkthrough.json` (review dir = `<repo>/.reviewroom/<branch>` or `--dir`; see `cli/lib/config.ts`).

```jsonc
{
  "version": 1,
  "title": "Attach recent HABIT events to the ranker request",
  "chapters": [
    {
      "id": "why",                       // ^[a-z0-9][a-z0-9-]*$, unique in the file
      "title": "Why this change",
      "lead": "<p class=\"rr-lede\">…</p><rr-flow>…</rr-flow>",   // HTML, optional, static for the chapter
      "steps": [                         // >= 1
        { "id": "s1", "text": "<p>…</p>", "ref": "rr:code/pkg/ranker/request_builder.go@base#L29-39" },
        { "id": "s2", "text": "<p>…</p>", "ref": "rr:code/pkg/features/habit/fetcher.go#L19-28" },
        { "id": "s3", "text": "<p>…</p>" }                        // no ref
      ]
    }
  ]
}
```

- `ref` accepts the `rr:` forms the narrative accepts (`rr:code/…`, `rr:file/…`, `rr:sym/…`, `rr:doc/…`); `code` and `file` are what the right pane renders. `sym` resolves through the provider like `app.open` does today.
- Step `id` is unique within its chapter. Anchors are `(chapter.id, step.id)`, so reordering steps keeps threads attached.
- Schema lives in `src/shared/walkthrough.ts` (Zod), JSON schema generated into `schema/walkthrough.schema.json` by `scripts/schema.ts` (`bun run schema`), the same way `state.json` works. A test fails when the committed JSON schema is stale, like the state one.
- Prose HTML is the author's; the client never rewrites it (same contract as the narrative).

## Architecture

```
walkthrough.json ──GET /api/walkthrough──▶ StateBackend.walkthrough()
      │                                          │
      │ reviewroom check                         ▼
      │  (schema + refs via links.ts)      walkthroughMachine (XState, src/flows/walkthrough.ts)
      │                                    closed ─open─▶ playing(chapter, step) ◀─resume─ paused
      │                                             ◀─close─        ─pause─▶
      ▼                                                   │
reviewroom walkthrough publish ──▶ PR comment      WalkthroughView (src/overlays/walkthrough.ts)
reviewroom pr ◀── PR comment/description            ├─ left: lead + step text + "Comment on this step"
                                                    ├─ right: CodeView of the step ref (or lead diagram)
                                                    ├─ bottom: prev/next, chapter segments + step ticks
                                                    └─ pill when paused
Comment ──▶ createThread { anchor: { kind:'tour', chapter, step } } ──▶ threads panel, feedback round
```

### Files to touch

| Area | File | Change |
|---|---|---|
| Schema | `src/shared/walkthrough.ts` (new) | Zod `Walkthrough`, `Chapter`, `Step`; `walkthroughJsonSchema()`; `issueText` reuse |
| Schema | `src/shared/schema.ts` | `Anchor` gains `{ kind: 'tour', chapter, step }` |
| Schema | `scripts/schema.ts`, `schema/walkthrough.schema.json` (new) | generate both schemas |
| Refs | `src/shared/refs.ts` | `rr:tour/<chapter>/<step>`: `parseRef`, `formatRef`, `anchorRef`, `anchorOf` |
| Refs | `src/core/refs.ts` | `refLabel`/`refIcon` for `tour` |
| Feedback | `src/shared/feedback.ts` | `anchorText` for `tour` (chapter title, step n, step text as context) |
| Server | `cli/lib/server.ts` | `GET /api/walkthrough` (200 JSON, 404 none, 422 invalid with issues); watch `walkthrough.json` in `watchNarrative` and push the existing change event |
| Check | `cli/commands/check.ts`, `cli/lib/links.ts` | validate `walkthrough.json` schema; collect refs from `ref` fields and prose; `checkLinks`; `--fix` rewrites moved refs in the JSON |
| PR | `cli/commands/pr.ts`, `cli/lib/github.ts` | pull the fenced block from the PR description or comments; `walkthrough publish` subcommand posts/updates the comment |
| CLI | `cli/reviewroom.ts`, `cli/commands/walkthrough.ts` (new) | `reviewroom walkthrough publish` and help text |
| Client | `src/providers/index.ts` | `StateBackend.walkthrough(): Promise<Walkthrough | null>` for `ServerState` and `BrowserState` (static fixture: inline) |
| Client | `src/flows/walkthrough.ts` (new) | the machine and its tests |
| Client | `src/overlays/walkthrough.ts` (new), `src/styles/walkthrough.css` (new) | the view, the pill, keyboard, transitions |
| Client | `src/shell/chrome.ts` | header "Walkthrough" button (only when a walkthrough exists) |
| Client | `src/shell/app.ts` | `app.open('rr:tour/…')` opens the player at that step; `label()` for tour refs |
| Client | `src/index.ts` | `rr.walkthrough(chapter?, step?)` on `window.rr`; `?walkthrough=<chapter>/<step>` deep link at boot |
| Client | `src/panels/sidebar.ts` | Threads panel labels tour threads "Walkthrough · <chapter> · step n"; clicking opens the player |
| Demo | `examples/habit-events/walkthrough.json` (new), `scripts/build-demo.ts` | the mockup's three chapters; static demo inlines it |
| Docs | `skills/reviewroom/references/authoring.md`, `skills/reviewroom/SKILL.md`, `README.md` | format, when to write one, how to answer step threads |
| Tests | `src/**/*.test.ts`, `e2e/*.test.ts` | per issue |

### Player behaviour

- Open: header button, palette command "Play walkthrough", `rr.walkthrough()`, deep link, or `app.open('rr:tour/<c>/<s>')`.
- Navigation: Prev/Next buttons, ← → keys (not while typing in the composer), chapter menu from the chapter title, chapter arrows, progress ticks. Crossing a chapter edge swaps the lead with a fade.
- Right pane: `code`/`file` refs render the file's diff (or whole file for `rr:file`) with the ref's lines highlighted; same file → scroll + highlight glide, different file → fade swap. Reuse the code panel's CodeView setup (`src/panels/code.ts`, see `openInNewPanel` for a second instance); do not write a second diff renderer. Links inside step text that point at code retarget the right pane without changing the step.
- Pause: player scales into a pill "▶ Resume · <chapter> · n/m" bottom-right with a thin progress bar; scrim gone; workbench fully interactive. Resume restores the same step. Close returns to the workbench; the header button reopens at chapter 1 step 1 (or the last step within the session, implementer's choice, keep it simple).
- Comment: composer inside the left pane, anchored to the current step, same `composer()` from `src/overlays/thread.ts` with the agent send button. After sending, the step divider shows a badge with the thread count; the progress tick gets a dot.
- Missing walkthrough: no header button; `rr.walkthrough()` shows a toast "No walkthrough for this review".
- Invalid walkthrough (422): header button present but disabled with the first issue as its tooltip, so the author sees it in the UI as well as in `check`.

### Sharing through the PR

- Block format in a PR comment or description:

  ````
  ```reviewroom-walkthrough
  { …walkthrough.json… }
  ```
  ````

- `reviewroom pr <n>`: if the review dir has no `walkthrough.json`, take the newest block found in the description or the conversation comments (`fetchPr` already loads both), validate, write it. A local file always wins; say on stderr where the walkthrough came from.
- `reviewroom walkthrough publish`: validate (same as `check`), then create or update a PR conversation comment that holds the block, marked with an HTML comment `<!-- reviewroom-walkthrough -->` so it is found again. Refuse above GitHub's 65,536-character comment limit with a clear message. Posts as the gh user, like every other GitHub write.

## Scope and parallelism

```
E1 Format & validation     E3 Step comments           E4 PR sharing
 1.1 schema ──┬─▶ 1.2 serve ─┐  3.1 anchor+ref ◀── 1.1   4.1 pull on `pr` ◀── 1.1
              ├─▶ 1.3 check  │        │                   4.2 publish ◀── 1.3, 4.1
              └─▶ 2.1 machine│        ▼
E2 Player            │       └─▶ 2.2 view ──▶ 3.2 comment from player
                     └────────────▶ 2.3 entry points (header, palette, deep link, rr API)
E5 Demo & docs       5.1 demo ◀── 1.2, 2.2      5.2 docs ◀── 2.3, 3.2, 4.2
```

After 1.1, these run in parallel: 1.2, 1.3, 2.1, 3.1, 4.1.

Beads IDs follow the numbering: epic `rr-d96.1` holds `rr-d96.1.1` (1.1), `rr-d96.1.2` (1.2), `rr-d96.1.3` (1.3); likewise `rr-d96.2.*`, `rr-d96.3.*`, `rr-d96.4.*`, `rr-d96.5.*`. `bd ready` lists what is unblocked; `bd show <id>` has the full brief for each unit.

## Out of scope for v1

Autoplay, stacked PRs, per-step screenshot tooling (the deep link is the hook; `rr-fa0` covers preview), animation beyond CSS transitions, threads rendered inside the slide, editing the walkthrough from the UI.

## Verification for the whole feature

1. `bun run check` green (typecheck, lint, unit, e2e).
2. `bun run demo`: header shows Walkthrough; play through all three chapters in light and dark, wide and laptop; pause, use the workbench, resume at the same step; comment on a step, see it in Threads; `reviewroom status --threads` lists it with the step context; reply with `reviewroom reply`, see the reply in the thread.
3. `reviewroom check` on the demo reports every ref ok; break one ref, see it reported; `--fix` heals a moved one.
4. On a real PR: `reviewroom walkthrough publish`, then on a clean clone `reviewroom pr <n>` pulls it and plays it.
