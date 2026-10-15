# reviewroom — contributor guide

This file is for agents and people **changing reviewroom itself**. If you are using reviewroom to
review a PR, read `skills/reviewroom/SKILL.md` instead.

## What it is

A local, agent-driven code review workbench. An agent writes a freeform HTML narrative of a change;
reviewroom serves it next to a live diff of the local git clone, with dockable panels, anchored
comment threads and feedback rounds between reviewer and agent. Two halves:

- **CLI + server** (`cli/`): reads git, serves the page and its API,
  stores threads/rounds on disk, runs the round loop.
- **Client** (`src/` → `dist/`): framework-free TypeScript bundled with Bun (`scripts/build.ts`). Boots from a
  `<rr-app>` element in the review page.

## Map

```
cli/reviewroom.ts    entry: usage text + dispatch to commands/
cli/commands/         one module per command group: pr, serve (review), threads (status --threads, reply, comment), status (status, stop), check
cli/lib/              git.ts (validated git layer), server.ts (HTTP API, origin guards, SSE), state.ts,
                      github.ts (PR threads via gh), scaffold.ts, args.ts, links.ts (stale-link check)
src/index.ts          boot(), the window.rr API for review authors, command/shortcut registry
src/core/             data model (types), rr: links (refs), commands, markdown, small DOM helpers
src/shared/           used by both the client and the CLI (no DOM, no Node): schema (state.json + ops, Zod), ops (the reducer), feedback
src/providers/        where code comes from (local server, GitHub, static fixture) and where state lives
src/shell/            ReviewApp (shared context + events), dock layout & presets, header
src/panels/           dockable panels: narrative, code, files/contents/threads
src/overlays/         thread popup/panel + composer, palette, hover previews, tooltips, toasts
src/elements/         custom elements review authors use (<rr-ref>, <rr-code>, <rr-flow>, …)
src/styles/           tokens.css (every colour/font as --rr-* variables) + component styles
schema/               JSON schema of state.json (the contract between UI, CLI and agents), generated from src/shared/schema.ts
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
- **`state.json`** follows `schema/state.schema.json`; the CLI, browser and agents all write it. Change it in
  `src/shared/schema.ts` (Zod: the TS types, op validation and the CLI's load check come from it), then `bun run schema`.
  The CLI moves a `state.json` that breaks the schema aside, like a corrupt one.
- **`~/.reviewroom/sessions/<pid>.json`** (`REVIEWROOM_HOME` overrides `~/.reviewroom`): written by every running
  server and removed on exit; other local tools (agent-annotation-hub) list running reviews from it.
  `~/.reviewroom/layout.json` holds the reviewer's default panel layout (Layout menu → Save layout as default).
- **CLI commands and flags** documented in `reviewroom --help` (`cli/reviewroom.ts`): the help is the reference, keep it complete.
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
mise run check        # typecheck, lint (oxlint, knip, jscpd), tests, end-to-end smoke test: run before committing
mise run demo         # demo repo + live review on localhost
mise run demo-page    # self-contained demo HTML in .demo/
```

`dist/` is build output and not committed. `reviewroom` (the plugin's `bin/` and `mise run demo`) runs the
built CLI in `dist/cli/`, not `cli/` source: keep `mise run dev` running while you change the CLI. Verify UI changes in a real browser (light and dark,
wide and laptop widths) on the demo before calling them done.

To get a new build into Claude Code sessions, build and then reinstall the plugin:

```bash
claude plugin uninstall reviewroom@reviewroom
claude plugin install reviewroom@reviewroom
```

Running review servers keep their old build until restarted.
