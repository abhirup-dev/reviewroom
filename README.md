# reviewroom

An agent-driven code review workbench. The agent writes a **freeform HTML narrative** of a change;
reviewroom puts it next to a **live diff of your local clone** and gives you everything around it:
docking panels, contents, a file tree, symbol search, anchored comment threads, and Crit-style
**review rounds** with the agent.

```
┌ header: PR · round · ⌘K · pick · layout · theme · Send feedback ──────────────────────────┐
│ Contents  │ Review (agent's HTML)                       ┊ │ Code (@pierre/diffs)           │
│ Pinned    │   prose, <rr-flow> diagrams, widgets,       ┊ │   all files, split/unified,    │
│───────────│   live <rr-code> snippets, rr: links        ┊ │   ws, +/− focus, wrap,         │
│ Files     │   highlights + thread chips in the margin → ┊ │   inline threads, base/head    │
│ Threads   │                                             ┊ │   full file, commit ranges     │
└───────────┴─────────────────────────────────────────────┴─┴────────────────────────────────┘
       every pane is a dockview panel: drag tabs to split/stack, float, maximise; layouts persist
```

## Quick start

In Claude Code (installs the skill and puts `reviewroom` on the agent's PATH):

```
/plugin install reviewroom --marketplace abhirup-dev/reviewroom
```

Then ask for a review: *"review PR 4821 in reviewroom"*. Without Claude Code, `npm i -g reviewroom`
and point your agent at [`skills/reviewroom/`](skills/reviewroom/SKILL.md):

```bash
reviewroom pr 4821 --repo ~/Codes/your-repo           # PR number, PR URL or branch; opens the browser
```

Contributing to reviewroom itself (`mise run setup`, `mise run demo`): [AGENTS.md](AGENTS.md).

## The review loop

1. The agent writes `review.html` and runs `reviewroom review` (blocks).
2. You read, jump into code, comment on anything, and press **Send feedback** (or **Approve**).
3. The command exits printing structured feedback; the agent replies per thread
   (`reviewroom reply <id> "…"`), adds `data-round="2"` sections for bigger answers, changes code,
   and runs `reviewroom review` again. Your open tab reconnects and shows round 2.

Everything is kept in `.reviewroom/<branch>/` (auto-added to `.git/info/exclude`):
`review.html`, `state.json` (threads, rounds, viewed files, sign-offs), `config.json`, and
`rounds/<n>/{review.html,feedback.md}` — browse old rounds from the **Round** menu.

## GitHub threads and team reviews

For a PR reviewed with `reviewroom pr <n>` (and `gh` logged in), the PR's own comment threads show
up in the diff and in **Threads › GitHub**, with avatars, drafts, outdated markers and links to
github.com. Reply, edit, delete and resolve there as on GitHub. The header's **Agent / Team** switch
picks where your new code and general comments go: to the agent (round by round), or into your
pending GitHub review, posted with **Submit review** (comment, approve or request changes).
Narrative comments always go to the agent. The agent sees GitHub threads read-only and can link
them (`rr:thread/gh_<n>`).

The PR's own **Description** sits above the agent's review.
The **CI** tab (next to Threads) shows the latest commit's checks, from GitHub Actions or any CI that
reports a commit status (Jenkins, TeamCity, …). When it failed or is still running, it also shows the
last commit on the PR that passed; while checks run it refreshes every 30 seconds.

## Commenting

- **Select text** in the narrative → Comment / Copy link / Pin.
- **Hover any block** (paragraph, list item, table, diagram, widget) → gutter handle → comment on the whole block.
- **Hold Alt** (or press `x`, or the target button) to pick **any element**, devtools-style.
- **Code:** click/drag line numbers to select a range, or the `+` in the gutter.
- Threads render as passive highlights + chips in the margin (narrative) or compact rows (code),
  open as a centred markdown popup, and can be **docked** as a panel.
- In the composer, `[[` links anything (sections, files, lines, symbols, threads); a pasted `rr:` link becomes a chip;
  `![](rr:…)` embeds a live preview.

## Keyboard

| | |
|---|---|
| `⌘K` / `Ctrl K` | Go to anything (files, sections, threads, commands; `#` symbols, `/` search code) |
| `g n` `g c` `g f` `g t` `g o` | Focus narrative / code / files / threads / contents |
| `n` `p` or `]` `[` | Next / previous section (narrative) |
| `j` `k`, `J` `K` / `] f` `[ f` | Next / previous change, file (code) |
| `s` `w` `i` `+` `-` `v` | Split/unified, wrap, ignore whitespace, focus new/old, mark viewed (code) |
| `c` | Comment on current selection |
| `x` / hold `Alt` | Pick an element to comment on |
| `Alt 1–4` | Layouts: reading, wide code, code focus, narrative focus |
| `⌘⇧↵` | Finish round & send feedback |
| hover anything | Tooltip explaining it, with its shortcut |

## Code sources

1. **Local clone** (default, via the CLI server): `git diff`, `git show`, `git grep` — no rate limits,
   symbol search across the whole repo, works offline, `--head worktree` for uncommitted changes.
2. **GitHub** fallback (`<rr-app repo="owner/name">` + base/head in `#rr-meta`): 2 API calls per
   review; file contents come from raw.githubusercontent.com. Token: `localStorage['reviewroom:github-token']`.
3. **Static fixture** (`<script type="application/json" id="rr-fixture">`): self-contained demos.

Write your own by implementing `CodeProvider` (`src/providers/index.ts`).

## Package layout

```
src/
  index.ts            boot(), window.rr API, commands
  core/               types, rr: refs, commands/keys, markdown, emitter, dom helpers
  providers/          LocalProvider + ServerState (CLI), GitHubProvider, StaticProvider, BrowserState
  shell/              ReviewApp (shared context), dockview layout + presets, header
  panels/             narrative, code (@pierre/diffs), files/contents/threads
  overlays/           thread popup/panel + composer, palette, selection toolbar, hover previews, toasts
  elements/           <rr-ref> <rr-embed> <rr-code> <rr-flow>/<rr-node> <rr-callout> <rr-checklist> <rr-markdown>
  styles/             tokens.css (all colours/fonts as --rr-* variables) + component styles
cli/reviewroom.mjs   zero-dependency server + round commands
templates/            review.html scaffold
schema/               JSON schema for state.json
skills/reviewroom/   the skill agents use (SKILL.md + references/)
```

Exports: `import { boot, definePanel, ReviewApp, LocalProvider, … } from 'reviewroom'`;
`reviewroom/style.css` if you want the stylesheet as a file (it is injected automatically otherwise).
Restyle by overriding `--rr-*` variables; add panels with `definePanel()`; add commands with
`rr.commands.register()`.

Built on [@pierre/diffs](https://diffs.com) (diff rendering) and [dockview](https://dockview.dev) (docking).
