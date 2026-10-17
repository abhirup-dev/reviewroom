# reviewroom: contributor guide

For changing reviewroom itself. To review a PR with it, read `skills/reviewroom/SKILL.md`. Vocabulary: `CONTEXT.md`.

## Layout

- `cli/` (Bun, built to `dist/cli/`): reads git, serves the page and its API, stores threads and rounds, runs the
  round loop. `reviewroom.ts` dispatches to `commands/`; `lib/` holds git, server, state, GitHub (Octokit, as the `gh` user).
- `src/` (browser, framework-free, built by `scripts/build.ts`): boots from `<rr-app>` in `review.html`.
  `shared/` is used by the CLI too (no DOM, no Node): Zod schema, op reducer, `rr:` grammar, feedback text.
  `flows/` holds the XState machines (thread popup, server sync); views subscribe.
- `e2e/`: the built CLI under Bun against the demo repo. `examples/`: demo review and demo repo script.

## Contracts (change deliberately, update the skill when you do)

- **The walkthrough is the agent's.** The client never rewrites `<rr-review>` content; it only layers tools around it
  (CSS Highlight API, overlays, data attributes).
- **`rr:` links** (`src/shared/refs.ts`) address everything in HTML, threads, the CLI and agent replies. Keep old forms
  parsing.
- **`state.json`** is written by the CLI, browser and agents. Change it in `src/shared/schema.ts`, then `bun run schema`
  to regenerate `schema/state.schema.json`. A `state.json` that breaks the schema is moved aside like a corrupt one.
- **`~/.reviewroom/`** (`REVIEWROOM_HOME`): `reviews/<owner>-<repo>/<branch>/` holds every review (nothing is written
  into the reviewed repo); `sessions/<pid>.json` per running server, read by other local tools (agent-annotation-hub);
  `layout.json` is the reviewer's default panel layout.
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
