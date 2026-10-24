# reviewroom

An agent-driven code review workbench. The agent writes a **freeform HTML walkthrough** of a diff;
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

The CLI runs on [Bun](https://bun.sh) (>= 1.3.12). In Claude Code (installs the skill and puts `reviewroom` on the agent's PATH):

```
/plugin install reviewroom --marketplace abhirup-dev/reviewroom
```

Then ask for a review: *"review PR 4821 in reviewroom"*. Without Claude Code, `bun add -g reviewroom`
and point your agent at [`skills/reviewroom/`](skills/reviewroom/SKILL.md). The `reviewroom` CLI
documents itself: `reviewroom --help`.

Contributing to reviewroom itself: [AGENTS.md](AGENTS.md).

## The review loop

1. The agent writes `review.html` and waits for you.
2. You read, jump into code, comment on anything, and press **Send feedback** (or **Approve**).
3. The agent gets structured feedback, replies per thread, adds `data-round="2"` sections for bigger
   answers, changes code, and waits again. Your open tab reconnects and shows round 2.

Everything is kept outside the repo, in `~/.reviewroom/reviews/<owner>-<repo>/<branch>/`:
`review.html`, `state.json` (threads, rounds, viewed files, sign-offs), `config.json`, `layout.json`
(the panels as you left them), and `rounds/<n>/{review.html,feedback.md}` — browse old rounds from the
**Round** menu. Layouts you save from the layout menu go to `~/.reviewroom/layouts/`, for every review.

## Use reviewroom from a phone

A phone reaches your reviews through the hub, which serves each one at `/r/<id>/`. reviewroom only binds
`127.0.0.1` and ships no tunnel or Tailscale code: put any front that ends in HTTPS in front of the hub, then tell
the hub its public origin once.

```bash
tailscale serve --bg 4847                                   # or any HTTPS tunnel to 127.0.0.1:4847 that admits only you
reviewroom hub --public-origin https://mac.tailnet.ts.net   # saved in ~/.reviewroom/config.json; restart the hub to apply
```

Open the public URL on the phone: the hub lists your reviews, and each opens in a phone layout (bottom tabs,
sheets, touch commenting). Install it from **More › Install app** or the palette (`Install app`); on iOS, Safari's
**Share › Add to Home Screen**. It updates itself when you rebuild or upgrade reviewroom, waiting while a comment is
unsent. Pick the origin for good: an installed app is tied to it. Anyone the front lets through can read and write
every running review.

## Guided walkthroughs

An agent can also write a guided walkthrough, `walkthrough.json`: chapters of slides the reviewer plays
over the workbench, narration on the left, the slide's code (one chunk or several, across files) on the
right, ← → between slides, pause to a pill to dig around, and **Comment** on a slide to start a thread
anchored to it. It tells the main story; the walkthrough (`review.html`) is where the reviewer digs in,
and a slide that draws questions gets a walkthrough section of its own with the slide embedded
(`<rr-embed ref="rr:tour/…">`).
The agent plays every slide in a headless browser to check it fits the screen. A PR author can ship one
with the PR, and a review of that PR pulls it. The demo has one (**Guided walkthrough** in the header).

## GitHub threads and team reviews

For a GitHub PR review (with `gh` logged in), the PR's own comment threads show
up in the diff and in **Threads › GitHub**, with avatars, drafts, outdated markers and links to
github.com. Reply, edit, delete and resolve there as on GitHub. The header's **Agent / Team** switch
picks where your new code and general comments go: to the agent (round by round), or into your
pending GitHub review, posted with **Submit review** (comment, approve or request changes).
Narrative comments always go to the agent. The agent sees GitHub threads read-only and can link
them (`rr:thread/gh_<n>`).

Thread markers tell the two apart: GitHub's mark for threads on the PR, Clawd for threads with the
agent, each with its message count; they turn grey once resolved.
The PR's own **Description** sits above the agent's review: read-only (edit it on GitHub), but you can
comment on it like the walkthrough, and those threads go to the agent.
The **CI** tab (next to Threads) shows the latest commit's checks, from GitHub Actions or any CI that
reports a commit status (Jenkins, TeamCity, …). When it failed or is still running, it also shows the
last commit on the PR that passed; while checks run it refreshes every 30 seconds.

## Commenting

- **Select text** in the walkthrough → Comment / Copy link / Pin.
- **Hover any block** (paragraph, list item, table, diagram, widget) → gutter handle → comment on the whole block.
- **Hold Alt** (or press `x`, or the target button) to pick **any element**, devtools-style.
- **Code:** click/drag line numbers to select a range, or the `+` in the gutter.
- Threads render as passive highlights + chips in the margin (walkthrough) or compact rows (code),
  open as a centred markdown popup, and can be **docked** as a panel.
- In the composer, `[[` links anything (sections, files, lines, symbols, threads); a pasted `rr:` link becomes a chip;
  `![](rr:…)` embeds a live preview.

## Keyboard

| | |
|---|---|
| `⌘K` / `Ctrl K` | Go to anything (files, sections, threads, commands; `#` symbols, `/` search code) |
| `g n` `g c` `g f` `g t` `g o` | Focus walkthrough / code / files / threads / contents |
| `n` `p` or `]` `[` | Next / previous section (walkthrough) |
| `j` `k`, `J` `K` / `] f` `[ f` | Next / previous change, file (code) |
| `s` `w` `i` `+` `-` `v` | Split/unified, wrap, ignore whitespace, focus new/old, mark viewed (code) |
| `c` | Comment on current selection |
| `x` / hold `Alt` | Pick an element to comment on |
| `Alt 1–4` | Layouts: reading, wide code, code focus, walkthrough focus (`narrative-focus`) |
| `⌘⇧↵` | Finish round & send feedback |
| hover anything | Tooltip explaining it, with its shortcut |
| double-click a file, diff header, section or pin | Open it big in a centred window (`Esc` puts it back) |

## Code sources

1. **Local clone** (default, via the CLI server): `git diff`, `git show`, `git grep` — no rate limits,
   symbol search across the whole repo, works offline, uncommitted changes too.
2. **GitHub** fallback (`<rr-app repo="owner/name">` + base/head in `#rr-meta`): 2 API calls per
   review; file contents come from raw.githubusercontent.com. Token: `localStorage['reviewroom:github-token']`.
3. **Static fixture** (`<script type="application/json" id="rr-fixture">`): self-contained demos.

Write your own by implementing `CodeProvider` (`src/kernel/providers/contracts.ts`).

## Package layout

```
src/
  main.ts             boot, public exports, window.rr, feature composition
  app.ts              ReviewApp compatibility facade and lifecycle
  services.ts         composition of narrow code, thread and GitHub services
  kernel/             state/refs, DOM helpers, dock, layouts, providers, header
  review/             code/walkthrough/files/contents, elements, previews, navigation
  threads/            local/GitHub threads, composer, controls, CI and docking
  slides/             guided walkthrough model, player machines, view and audit
  hub/                standalone hub UI and model
  testing/            DOM fixtures and integration tests
  */styles/           CSS owned by each feature; build.ts preserves cascade order
  *.shared.ts         DOM-free contracts shared with the CLI (also within folders)
  *.machine.ts        DOM-free XState machines, beside their owning views
cli/                  CLI (TypeScript, bundled for Bun): server + round commands
templates/            review.html scaffold
schema/               JSON schema for state.json (generated from src/kernel/state/schema.shared.ts)
skills/reviewroom/   the skill agents use (SKILL.md + references/)
```

Exports: `import { boot, definePanel, ReviewApp, LocalProvider, … } from 'reviewroom'`;
`reviewroom/style.css` if you want the stylesheet as a file (it is injected automatically otherwise).
Restyle by overriding `--rr-*` variables; add panels with `definePanel()`; add commands with
`rr.commands.register()`.

Built on [@pierre/diffs](https://diffs.com) (diff rendering) and [dockview](https://dockview.dev) (docking).
Thread markers: Clawd icons by [Icons8](https://icons8.com), GitHub's mark from [Octicons](https://primer.style/octicons).
