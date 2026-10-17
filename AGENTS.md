# reviewroom: contributor guide

For changing reviewroom itself. To review a PR with it, read `skills/reviewroom/SKILL.md`. Vocabulary: `CONTEXT.md`.

## Layout

- `cli/` (Bun, built to `dist/cli/`): reads git, serves the page and its API, stores threads and rounds, runs the
  round loop. `reviewroom.ts` dispatches to `commands/`; `lib/` holds git, server, state, GitHub (Octokit, as the `gh` user).
- `src/` (browser, framework-free, built by `scripts/build.ts`): boots from `<rr-app>` in `review.html`.
  `shared/` is used by the CLI too (no DOM, no Node): Zod schema, op reducer, `rr:` grammar, feedback text.
  `flows/` holds the XState machines (thread popup, server sync, layout save, the guided walkthrough player and its code pane,
  a code panel's reveal); views subscribe.
- The guided walkthrough (`walkthrough.json`): schema and PR block in `src/shared/walkthrough.ts`, player in
  `src/overlays/walkthrough.ts`, CLI in `cli/commands/walkthrough.ts` (publish, lint, shot) with `cli/lib/tour-lint.ts`
  (its checks) and `cli/lib/render.ts` (the headless browser, `Bun.WebView`: its only user).
- `e2e/`: the built CLI under Bun against the demo repo. `examples/`: demo review and demo repo script.

## Where reviews live

By default in `~/.reviewroom/reviews/<owner>-<repo>/<branch>/`, never inside the reviewed repo.

## Contracts (change deliberately, update the skill when you do)

- **The walkthrough is the agent's.** The client never rewrites `<rr-review>` content; it only layers tools around it
  (CSS Highlight API, overlays, data attributes).
- **`rr:` links** (`src/shared/refs.ts`) address everything in HTML, threads, the CLI and agent replies. Keep old forms
  parsing.
- **`walkthrough.json`** (the guided walkthrough) follows `schema/walkthrough.schema.json`, generated from
  `src/shared/walkthrough.ts` by `bun run schema`. It can come from a PR comment: its prose is sanitized.
- **`state.json`** is written by the CLI, browser and agents. Change it in `src/shared/schema.ts`, then `bun run schema`
  to regenerate `schema/state.schema.json`. A `state.json` that breaks the schema is moved aside like a corrupt one.
- **`~/.reviewroom/`** (`REVIEWROOM_HOME`): `reviews/` (above), `sessions/<pid>.json` per running server, read by
  `reviewroom hub` (which deletes records whose server is gone) and other local tools; `hub.json` is the running hub;
  `layouts/<name>.json` are the reviewer's saved layouts, in the format of `src/shared/layout.ts` like the shipped ones
  in `src/layouts/` (whose names they can't take); `default-layout.json` names their default.
- **`reviewroom --help`** (`cli/reviewroom.ts`) is the CLI reference: keep it complete.
- **`window.rr` and the custom elements** are documented in `skills/reviewroom/references/authoring.md`.

## Conventions

- Panels via `definePanel()`; everything talks through `ReviewApp` and its event bus. Palette commands and shortcuts go
  through the registry in `src/core/commands.ts`.
- Colours and fonts only through `--rr-*` tokens (`src/styles/tokens.css`).
- Controls whose purpose isn't obvious get a `title` (add `data-keys` for a shortcut hint).
- No raw `rr:` strings, ids or CSS paths in visible text: use `app.label()` / `describeElement()`.

## Working on it

Bun (>= 1.3.12) installs, builds, tests and runs the built CLI. Libraries are bundled into `dist/` (not
committed), so all are `devDependencies`.

```bash
bun run setup       # install, build, put `reviewroom` on PATH
bun run dev         # rebuild on change; `reviewroom` runs dist/, not cli/ source
bun run check       # typecheck, lint, tests, e2e: run before committing
bun run demo        # demo repo + live review
```

Verify UI changes in a real browser on the demo (light and dark, wide and laptop widths). To get a new build into
Claude Code, reinstall the plugin (`claude plugin uninstall reviewroom@reviewroom`, then `install`); running servers keep
their old build until restarted.

## Agent skills

- Issue tracker: Beads (`bd`). See `docs/agents/issue-tracker.md`.
- Triage labels: the five defaults. See `docs/agents/triage-labels.md`.
- Domain docs: single-context (`CONTEXT.md`, `docs/adr/`). See `docs/agents/domain.md`.
