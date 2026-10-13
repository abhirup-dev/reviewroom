# reviewroom — contributor guide

This file is for agents and people **changing reviewroom itself**. If you are using reviewroom to
review a PR, read `skills/reviewroom/SKILL.md` instead.

## What it is

A local, agent-driven code review workbench. An agent writes a freeform HTML narrative of a change;
reviewroom serves it next to a live diff of the local git clone, with dockable panels, anchored
comment threads and feedback rounds between reviewer and agent. Two halves:

- **CLI + server** (`cli/`): reads git, serves the page and its API,
  stores threads/rounds on disk, runs the round loop.
- **Client** (`src/` → `dist/`): framework-free TypeScript bundled with Bun (`scripts/build.mjs`). Boots from a
  `<rr-app>` element in the review page.

## Map

```
cli/reviewroom.mjs   entry: usage text + dispatch to commands/
cli/commands/         one module per command group (pr, serve/review, init, threads/reply/comment/resolve, status/stop)
cli/lib/              git.mjs (validated git layer), server.mjs (HTTP API, origin guards, SSE), state.mjs,
                      scaffold.mjs, args.mjs; feedback.mjs is shared with the client
src/index.ts          boot(), the window.rr API for review authors, command/shortcut registry
src/core/             data model (types), rr: links (refs), commands, markdown, small DOM helpers
src/providers/        where code comes from (local server, GitHub, static fixture) and where state lives
src/shell/            ReviewApp (shared context + events), dock layout & presets, header
src/panels/           dockable panels: narrative, code, files/contents/threads
src/overlays/         thread popup/panel + composer, palette, selection toolbar, hover previews, tooltips, toasts
src/elements/         custom elements review authors use (<rr-ref>, <rr-code>, <rr-flow>, …)
src/styles/           tokens.css (every colour/font as --rr-* variables) + component styles
schema/               JSON schema of state.json (the contract between UI, CLI and agents)
skills/reviewroom/   the skill agents use to run reviews (entry point + references)
templates/            review.html scaffold
examples/             demo review + script that creates the demo git repo
scripts/              build (Bun), smoke test, static demo builder
```

## Contracts (change deliberately, update the skill when you do)

- **The narrative is the author's.** The client never rewrites `<rr-review>` content; it layers
  tools around it (highlights via the CSS Highlight API, overlays, data attributes only).
- **`rr:` links** (`src/core/refs.ts`) are the public addressing scheme used in HTML, threads, the
  CLI and agent replies. Keep old forms parsing.
- **`state.json`** follows `schema/state.schema.json`; the CLI, browser and agents all write it.
- **CLI commands and flags** documented in `reviewroom --help` (`cli/reviewroom.mjs`): the help is the reference, keep it complete.
- **`window.rr` and the custom elements** documented in `skills/reviewroom/references/authoring.md`.

## Conventions

- No UI framework. Panels are registered with `definePanel()`; everything talks through
  `ReviewApp` and its event bus. Commands (palette + shortcuts) go through the command registry.
- Colours and fonts only through `--rr-*` tokens; each panel kind sets its own surface.
- Any control whose purpose isn't obvious gets a `title` (rendered as the app's tooltip; add
  `data-keys` for a shortcut hint).
- Never show implementation detail to the reviewer: no raw `rr:` strings, ids or CSS paths in
  visible text. Use `app.label()` / `describeElement()` for human names.

## Working on it

Toolchain via [mise](https://mise.jdx.dev) (Node for the CLI, Bun for installs and scripts):

```bash
mise install          # once
mise run setup        # bun install, build, put `reviewroom` on PATH (bun link)
mise run dev          # rebuild on change
mise run check        # typecheck + end-to-end smoke test: run before committing
mise run demo         # demo repo + live review on localhost
mise run demo-page    # self-contained demo HTML in .demo/
```

`dist/` is build output and not committed. Verify UI changes in a real browser (light and dark,
wide and laptop widths) on the demo before calling them done.
