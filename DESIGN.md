---
version: alpha
name: reviewroom
description: A local workbench for reading a diff with an agent's report beside it. Warm paper and quiet tooling, square and dense, with colour kept for meaning.
colors:
  # the light theme; dark values follow as dark-* (the CSS switches with [data-rr-theme="dark"])
  primary: "#1b1a17"
  secondary: "#67635b"
  tertiary: "#b4570f"
  neutral: "#f2f1ec"
  surface: "#ffffff"
  on-surface: "#1b1a17"
  error: "#b42318"
  chrome: "#e4e2db"
  surface-nav: "#f2f1ec"
  surface-nav-2: "#e9e7e1"
  surface-doc: "#ffffff"
  surface-doc-2: "#f6f5f1"
  surface-code: "#fdfdfc"
  surface-well: "#eeede8"
  surface-bar: "#ebe9e3"
  surface-bar-active: "#f7f6f2"
  surface-overlay: "#ffffff"
  surface-overlay-2: "#f5f4f0"
  ink: "#1b1a17"
  ink-2: "#3d3b36"
  muted: "#67635b"
  faint: "#8d897f"
  line: "#dbd7cd"
  line-strong: "#c7c2b6"
  accent: "#b4570f"
  accent-soft: "#fdf0e1"
  comment: "#b4570f"
  comment-soft: "#fdf0e1"
  pin: "#b5179e"
  add: "#1a7f37"
  del: "#c2402a"
  ok: "#1a7f37"
  ok-soft: "#e4f4e8"
  warn: "#a35c00"
  warn-soft: "#fff3dc"
  risk: "#b42318"
  risk-soft: "#fdecea"
  sym-fn: "#7347c4"
  sym-type: "#0f7a6b"
  sym-value: "#9a6200"
  dark-chrome: "#07080a"
  dark-surface-nav: "#111317"
  dark-surface-doc: "#16191e"
  dark-surface-doc-2: "#22262d"
  dark-surface-code: "#0e1013"
  dark-surface-bar-active: "#1a1d23"
  dark-surface-overlay: "#22262d"
  dark-ink: "#e8e6e1"
  dark-ink-2: "#c9c6bf"
  dark-muted: "#a09c93"
  dark-line: "#2f343b"
  dark-line-strong: "#40464f"
  dark-accent: "#f0a35e"
  dark-comment: "#f0a35e"
  dark-pin: "#f07ad8"
  dark-add: "#8fc9a3"
  dark-del: "#eea393"
  dark-risk: "#f58b80"
typography:
  headline-lg:
    fontFamily: Mona Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Mona Sans
    fontSize: 23px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Mona Sans
    fontSize: 19px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  lede:
    fontFamily: Inter
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.5
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  label-lg:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1
  count:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: 600
    lineHeight: 1
  code:
    fontFamily: ui-monospace
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1.6
  code-sm:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  sm: 2px
  lg: 4px
spacing:
  2xs: 2px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 24px
  3xl: 32px
  4xl: 48px
  control-sm: 24px
  control: 28px
  control-lg: 32px
  bar: 36px
  band: 38px
  header: 52px
  indent: 14px
  doc-width: 760px
  tour-width: 1600px
  rail-width: 232px
  gen-width: 760px
  gen-row-gap: 28px
  gen-col-gap: 40px
  gen-gap: 12px
  gen-head-gap: 10px
  gen-head-pad: 20px
  gen-avatar: 20px
  gen-mark: 32px
  gen-mark-gap: 12px
  gen-step-gap: 24px
  gen-draft: 21.6px
  assistant-inset: 12px
  assistant-msg-gap: 8px
  assistant-row-gap: 4px
  assistant-gap: 12px
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 12px
    height: 32px
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.chrome}"
    rounded: "{rounded.sm}"
    height: 32px
  button-primary-hover:
    backgroundColor: "{colors.ink-2}"
  button-send-agent:
    backgroundColor: "{colors.comment}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    height: 32px
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: 28px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 8px
    height: 28px
  segmented-control:
    textColor: "{colors.muted}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 28px
  toolbar:
    backgroundColor: "{colors.surface-bar-active}"
    typography: "{typography.label-lg}"
    padding: 8px
    height: 36px
  file-band:
    backgroundColor: "{colors.surface-bar-active}"
    height: 38px
  group-label:
    textColor: "{colors.ink-2}"
    typography: "{typography.label-lg}"
  ref-chip:
    backgroundColor: "{colors.surface-doc-2}"
    textColor: "{colors.ink}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    height: 22px
  link:
    textColor: "{colors.ink}"
  thread-mark:
    textColor: "{colors.comment}"
    typography: "{typography.count}"
    size: 12px
  thread-mark-large:
    textColor: "{colors.comment}"
    typography: "{typography.label-md}"
    size: 18px
  round-tag:
    textColor: "{colors.ink-2}"
    typography: "{typography.label-sm}"
  unread-tag:
    textColor: "{colors.risk}"
    typography: "{typography.label-sm}"
  pin-mark:
    textColor: "{colors.pin}"
  floating-layer:
    backgroundColor: "{colors.surface-overlay}"
    rounded: "{rounded.lg}"
---

# Design System: reviewroom

The values are normative in `src/kernel/styles/tokens.css` (`--rr-*`); this file records them and explains how to use
them. If the two disagree, the CSS is right and this file is stale. Most rules here are also enforced by the build
(see Enforcement), so a change that breaks one fails `bun run check`.

## Overview

**Creative North Star: "The Reading Desk."** Warm paper on a desk. The agent's report is the document; files,
threads and toolbars are quiet tooling arranged around it on slightly darker, warmer planes. Reading comes first, and
the interface asks for attention only where the reviewer has to act.

The system is dense and square: 13px interface text, 28 to 32px controls, 2px corners, hairline borders. It should feel
like a well-made engineering tool (GitHub, Linear), not a consumer app. Colour is scarce and always means something;
nothing is coloured for decoration. Dark mode is near-black with blue-grey surfaces and pastel diff colours, so long
sessions stay calm.

**Key characteristics:**
- One sans for reading and interface (Inter), Mona Sans for headings, the system monospace for code.
- Planes separate by tone, not shadow; only floating layers cast shadows.
- Square: 2px corners on everything inside a panel, 4px on what floats.
- No blue on links, chips or highlights: links are ink, set apart by weight and underline.
- Every value from a token, every derived colour from one mix scale, enforced by lint.

## Colors

A warm neutral palette with one conversational colour (orange) and a handful of state colours.

- **Ink** (`primary`, `ink`, `ink-2`): text, headings, links, the primary button's fill. Links are ink, not blue.
- **Pencil** (`secondary`, `muted`, `faint`): metadata, captions, placeholders, idle icons.
- **Margin Orange** (`tertiary`, `comment`): conversation. Thread marks, comment highlights, the Agent send button,
  the feedback count. It marks talk, never navigation.
- **Paper planes** (`surface-*`): `chrome` behind the dock and in the header; `surface-nav` for Contents, Files and
  Threads; `surface-doc` for the report and thread windows; `surface-code` for code; `surface-bar` and
  `surface-bar-active` for tab bars and toolbars; `surface-overlay` for menus, dialogs and the palette.
- **Hairlines** (`line`, `line-strong`): borders, dividers, guide lines; strong for control outlines and active guides.
- **The accent** (`accent`): focus rings, the report's progress and the current position. It is Margin Orange, the same as `comment`: one accent across the interface, everything else ink and grey. Never links or highlights.
- **Magenta** (`pin`): what's pinned to Contents, and nothing else.
- **Diff** (`add`, `del`): added and removed code, its washes and changed words.
- **State** (`ok`, `warn`, `risk` with `-soft` fills): approved, caution, failure. `risk` also marks unread replies.
- **Symbol kinds** (`sym-fn`, `sym-type`, `sym-value`): the kind badge on links that name a function, type or value.

**Derived colours.** Every colour the CSS derives from a token goes through one mix scale, so a wash, tint or rule has
the same strength everywhere: `--rr-mix-xs` 6% (row washes, selections), `-sm` 12% (tints, badges, shadows, hover of
something tinted), `-md` 24% (rules or borders from a colour), `-lg` 48% (done marks, underlines meant to read). Fade
with `color-mix(in srgb, var(--rr-x) var(--rr-mix-sm), transparent)`; move one colour toward another with
`color-mix(in srgb, var(--rr-x), var(--rr-y) var(--rr-mix-sm))`. `--rr-hover` and `--rr-active` are ink at `xs` and
`sm`, translucent so they read on every surface.

**Code colours.** The syntax themes (`pierre-light`, `pierre-dark`) sit close to the paper, so every token colour is
pushed `--rr-code-contrast` (0.3) of the way from the surface: darker in light, lighter in dark, hue and chroma kept.
Selected lines use a neutral grey band, not a third diff colour.

### Named rules
**The Meaning Rule.** Orange is the one accent (talk, focus and progress), magenta is pinned, green and red are the
diff or state. Nothing is coloured for decoration.

**The Ink Link Rule.** A link is ink at medium weight over a faint 2px underline that firms up on hover. In a diagram
the label is medium weight with a drawn faint underline (SVG text takes no underline colour).

## Typography

**Text:** Inter, for both the report's prose and the interface.
**Headings:** Mona Sans (GitHub's face), 600, slightly tightened; h1 and h2 sit on a hairline, as in a GitHub README.
**Code:** the system monospace (SF Mono on a Mac), for code, paths, ids and identifiers.

A reader can switch to the classic set (Typography: classic serif): Source Serif 4 for the report, Inter for the
interface, JetBrains Mono for code, no heading rules. Inter, Mona Sans and the classic faces are bundled; nothing loads
from the network.

### Hierarchy
- **Headline** (Mona Sans 600): h1 32px, h2 23px, h3 19px. The walkthrough's chapter title is an h2 (desktop; the phone keeps its own).
- **Lede** (19px, `ink-2`): a report's opening paragraph.
- **Body** (16px / 1.5): the report. **Comments** 14px. **Interface** 13px: controls, rows, lists.
- **Label** (12px): tabs, group headings and toolbar titles at 600, in sentence case. Segments and chips at 500.
- **Small** (11px): metadata, round tags (`R2`, mono, semibold, no fill), the unread tag (dark red, semibold).
- **Count** (10px, 600): numbers inside a fixed box.
- **Code** 12.5px in the code panel, 12px in snippets.

### Named rules
**The Sentence Case Rule.** Labels and group headings are sentence case at 600 in `ink-2`. No tracked capitals in the
desktop interface.

**The Type Scale Rule.** Every font size is a `--rr-text-*` step (10, 11, 12, 13, 14, 16, 19, 23, 32px) or relative
to its context (em, %). Weights are 400, 500 and 600.

## Layout

A 52px header (`chrome`) over docked panels, one line: the mark, the change's number and title, an ⓘ and a small
diffstat on the left; search, status, generation (its indicator, or Generate), the walkthrough, a quiet icon group (layout, All reviews, theme) and Send feedback
on the right. The repository, author, branches, merge base and worktree live in a popover from the title or the ⓘ,
each row copying its value (and a PR opens on GitHub), not in the header. Every bar of tools (the dock's tab bars, the code panel's toolbar, a
floating window's title bar) is 36px with 8px padding at its ends and 6px between controls. A file's band, its status,
path, size and Viewed above its code, is 38px and is the same component in the code panel and the report.

Panels pick their surface by kind (`data-rr-kind`): navigation on `surface-nav`, the report and threads on
`surface-doc`, code on `surface-code`. A component paints `--rr-panel` and `--rr-panel-2`, which the panel holding it
sets, so it fits any panel. The report column is capped at 760px, and the thread rail beside it is 232px.

Spacing is a fixed scale: 2px steps up to 12 for dense controls (2, 4, 6, 8, 10, 12), then 16, 24, 32, 48 for layout.
Trees indent 14px per level.

**The walkthrough** is a two-column player on one sheet: narration and code both on `surface-doc` (no well, card
edges or band fill), the code full height under one white file band (path, Diff/Before/After, size, Viewed: the slide
decides how its diff is drawn, so no display toggles). Each chapter takes
a shape from its longest slide (`src/slides/fit.ts`), so nothing moves between its slides: short slides with no intro
read at the lede size (`text-xl`) a third of the way down beside a 28% narration, long ones (over 150 words) get 50%,
the rest 36%. Narrow code widens it, up to half: the code keeps only the room the chapter's longest changed line needs
(`codeWidth`, never less than the file band). A dragged width wins. The chapter title wraps under its arrows and position, ref chips wrap, and the
bottom bar is ticks only: nothing on the reading side is cut. The player stops growing at `tour-width` and sits centred,
so a wide screen keeps a laptop's proportions. The code is centred, whatever the narration does (`placement.ts`): the
slide's change (its lines and the change blocks they touch, or its lines alone when that is taller than the pane) sits
in the middle of the pane, near a file's ends too (blank room above its first line or below its last). The boundary
between the two sides drags; only the pointer says so (no line, no colour). One file
is shown whole, nothing folded; several share the pane by the height of what each shows (never less than its slide's
lines), folded to their hunks, each centred and scrolling on its own. Each demo slide is one of these cases, named and
checked in `testing/slides/layout.test.ts`.

Its diff is quiet (`diffs.css`, scoped to `.rr-tour`; the rest of the review keeps its look): no hairline beside the line
numbers, no change bars or selection band; its red, green and changed words (knocked out in the paper colour in light)
are the review's own, unchanged. Focus is two things only: the slide's lines get a rule at their numbers (in ink, semibold;
a split view's left column), and the file's changes outside the slide's change blocks fade. Split or unified, and wrap, are chosen per slide and file from
the change blocks the slide touches, whole (`fitDiff`), unless the reader picks Split or Unified in the file band's
Auto / Split / Unified switch (the `tourView` pref, Auto by default): split when they remove 5 lines or more, or more than
they add (a one-for-one change stays unified); wrap a compact change (5 changed lines or fewer) whose lines overflow a column, else clip and scroll sideways.

**Generation loading** (`src/review/generation.ts`, `generation.css`; its measures are the `--rr-gen-*` tokens, its own group in `tokens.css`, from which it derives the transcript's height) is a quiet full-page surface over the review, on desktop and phone, on the stage (`surface-stage`: cream paper; in dark, the deeper plane) with one accent, Margin Orange (`comment`); everything else is ink and grey, and nothing on it is red. Centred across and pinned from the top: Claude's box keeps a fixed size and the steps grow downwards, so nothing moves as the work goes on. The head runs across on a hairline: the repository, PR number and branches (`mono` `text-sm` `muted`), the PR's title (`text-2xl` display 600), then the author with GitHub's avatar (their initials in an `ink-2` tile without one) and when they opened it, the size (`+412 −88`, `mono`, in `add` and `del`) and the file count, `·` (`faint`) between them. No clock: it says what is happening, never how long it has taken. Under the head, the **generation steps** (no visible label: "Writing the review" is for screen readers), and beside them Claude's box with the actions in one row under it (under the steps where there is no box): Continue to the review (primary), Peek at the walkthrough once slides exist; after a stop, Retry and the walkthrough so far. It closes when the walkthrough passes (the player opens). Closed, the header's indicator (Clawd and the busy dots, still and without dots once stopped) shows generation running and opens the screen again.

- **Generation steps** (`generationSteps()` in `src/review/generation.machine.ts` derives them from the progress): Reading the diff (until the agent records that it has read it, or the walkthrough's first save), Writing the walkthrough (until a draft passes), Walkthrough ready, Writing the report. Each step is a square marker `control-lg` high (1.5px `line-strong` border, its number in `mono` 600 `muted`) joined to the next by a 2px `line` rule (`ink` once done) and a `text-lg` 600 title, `space-24` apart: the screen's subject, larger than the transcript beside it. No detail line under it; the detail is the step's tooltip. Done: an `ink` box with a check. Current: a dashed `comment` outline that marches, a `comment` square at its centre (steady under reduced motion). Stopped: an `ink-2` border and "!". Upcoming: `ink-2` title (500). Under Writing the walkthrough, the last two saves as `mono` `text-sm` rows, one line each (cut with an ellipsis, never wrapped) ("Draft 2 · 7 slides in 4 chapters · checking"; "passes" on the last), earlier ones folded into a count; the current row `comment` with a square, the rest `muted`. Steps never move backwards.
- **The assistant's box**: with the built-in assistant (and only on this machine's own URL, never through the hub) the steps and the assistant sit side by side in two equal columns 40px apart, in one 760px block centred on the stage (rows 28px apart). The steps start half their drafts' room lower than the transcript: an edgeless transcript reads as starting at its first line, so steps level with its top look taller; lowered, the four sit centred against it and, with every draft row, reach at most Claude's line. One measure ties them: the four steps with their most draft rows (4 markers + 3 × 24px + three draft rows) is the transcript's fixed height, so the steps never outgrow it; with the actions' row always reserved, nothing in the centred block moves as the work goes on. The assistant has no head: its transcript starts level with the first step and is exactly the steps' reserved height. Under it, 12px down, Claude's own line: Clawd, "Claude" and, while it works, Clawd's bob and the busy dots, the screen's one busy signal, with a quiet `muted` Stop at the line's end. The actions follow 12px below, sharing the column's width, so the column ends square. The transcript always follows its newest line. Under it, edgeless on the same page and of fixed height (it scrolls inside, so nothing moves), the page's one conversation with the assistant, read-only (no composer, no approvals): **the assistant's transcript**, below. Below 840px it goes under the steps. Your own agent gets a `muted` note instead.

**The assistant** (`src/assistant/`) is something to watch, not a console: the same transcript on the loading screen and in its panel, from one set of measures (the `--rr-assistant-*` tokens; the loading screen only places it: edgeless, its height fixed), edgeless on the surface it sits on, and calm. Its identity is Margin Orange and Clawd: Clawd on the header's "Claude" button and the loading screen's head, a robot (`bot`) on the panel's tab, Send (`rr-btn--agent`). **The busy signal** (`.rr-dots`, `.rr-clawd.is-working`, `controls.css`): Clawd bobs and three `comment` squares cycle; it replaces every "Working…". **The transcript**: what Claude says in `text-md` prose; each tool call in a hairline box (`line`, `radius`): its verb (500), its target (`mono`, `ink-2`, cut with an ellipsis: "Read  cli/lib/upload.ts", "Ran  bun test") and a `faint` `text-xs` state word (done, failed, denied; running and needs approval in `comment`). A failed call looks like any other and an error is a `muted` line: nothing red. Scrolled, what went past fades out at the top. What you sent sits on the right, as in a chat, on the well (`surface-well`, `radius`), its first lines only when long (fading out) with Show more / Show less (`muted`, never the accent). The generate prompt is instructions, not a question: one folded line, "Generate review artifacts", across the transcript on the well, opened on request. In the panel the transcript is edgeless on the panel's surface, the shared composer under it, and at the foot, beside Send, the model and its state; the busy dots run at the transcript's foot. The panel follows the transcript while you are at its foot, and stays put once you scroll up.

**Contents** follows the reader: the section and headings down to the one being read are bold, that last one is
underlined, and its guide lines firm up. Pinned entries sit at the top without a heading; the Report group has a
heading over a full-width hairline, its entries flush with the heading.

## Elevation & Depth

Flat at rest. Depth comes from tonal planes: chrome, then navigation, then paper. Shadows appear only on layers that
float above the page.

- **Small** (`--rr-shadow-sm`): a slight lift for cards inside a panel, the block handle.
- **Floating** (`--rr-shadow`): menus, hover cards, tooltips.
- **Modal** (`--rr-shadow-lg`) over a `--rr-scrim` backdrop: dialogs, the palette, the walkthrough player.

A floating thread window is the thread panel it docks into, on the same surfaces, with the dock's tab bar as its title
bar.

### Named rules
**The Float-Only Shadow Rule.** If it doesn't float, it has no shadow.

## Shapes

Square. 2px on chips, buttons, inputs, cards and blocks inside a panel; 4px on floating layers (menus, dialogs, the
palette, popovers, floating windows). 1px hairlines define controls and separate rows. Nothing is pill-shaped on the
desktop. The phone takes Material 3 Expressive shapes on the same palette (Phone, below).

## Components

### Buttons
- **Default:** 32px, 12px side padding, strong hairline border, current-surface fill, 500 weight. Hover: the
  translucent hover fill. Disabled: 50% opacity.
- **Primary:** ink fill with chrome-coloured text; hover lightens to `ink-2`.
- **Ghost:** no border or fill until hover. **Small:** 24px.
- **Icon button:** 28px square (24px in a bar), muted icon, hover fill; pressed uses the active fill.
- **Send:** one button wherever a comment can go. Agent is a flat `comment` fill; PR is a plain button. When the review
  mode leaves one out it stays visible at 45% opacity, its tooltip saying why.

### Toolbars, tabs and title bars
36px on `surface-bar-active`. Tabs lead with their panel's icon; the active tab is 600, others 500; the close cross is
small and shows on hover or on the focused panel. The Threads tab carries its open count ("Threads 3") as Files carries
its progress ("Files 0/5").

### Segmented controls and inputs
Segments share one hairline frame with dividers; the selected one takes the active fill. Inputs are 28px with a
hairline border; focus adds the accent ring.

### Links and reference chips
- **Link:** ink, medium weight, 2px underline at `--rr-mix-md` that turns solid on hover.
- **Symbol link:** mono, with a one-letter kind badge in its symbol-kind colour (ƒ function, S struct, T type, v value).
- **Ref chip:** 22px, `surface-doc-2` fill, ink text, hairline border that darkens on hover; mono when it names code.

### Thread marks
The agent's sprite (or GitHub's mark, or the starter's avatar) and the message count, with no fill. 12px in side panels,
18px with larger numbers in the report, the walkthrough and the code. Orange for the agent, `ink-2` for
GitHub, grey once resolved. In the Threads list the mark sits at the right end of the row, after the round tag; the
icon before the location (the report's page, code's brackets) says what the thread is on, so the list has no group
headings. "unread" (dark red, semibold) marks a thread the agent answered this round.

### Pins
A block pinned to Contents shows a small magenta pin after its text; a pinned section shows it after its heading.
Pinning a heading that opens a section pins the section.

### Link previews
Hovering a link for 400ms opens its preview; it closes 200ms after the pointer leaves the link and the card, and at
once on any scroll. A scroll moving content under a still pointer doesn't count as hovering.

### Report block actions
Either margin, or a 500ms block dwell, reveals Comment, Copy reference and Pin through a plus. The right shares the
thread rail and yields to its markers. Right-click offers Comment and Copy reference, preserving native menus.
Saved quotes stay highlighted; selecting text offers Comment. Only Pick/Alt outlines whole blocks; menus use a bracket.
Pick and Alt share one targeting state; headers and tools reflect it. Composing, opening a thread or changing rounds exits picking.

### Floating layers
Menus, the palette and dialogs: `surface-overlay`, hairline border, 4px radius, a shadow from the vocabulary above,
entering with a short fade (0.12 to 0.14s ease-out).
Action popups use the shared menu surface: hover fills sit over an opaque background, and clear labels need no repeated tooltip.

## Phone

The phone is its own presentation of the same features (`src/kernel/phone.ts`, `*.phone.ts`, `*.phone.css`), designed in
`docs/design/phone.md`: Material 3 Expressive shapes (`--rr-shape-*`, 4 to 28px and full), springs sampled as
`linear()` easings, touch sizes, and its own dark paper, on this palette. Core CSS never styles the phone; the phone's
CSS loads last and overrides.

The phone keeps this system's scales (type steps, spacing, mixes, weights 400/500/600) and takes Material 3's size for
each role, snapped to a step. It names no roles of its own: its CSS uses the steps directly.

| Role | Desktop | Phone (M3) | On the phone |
|---|---|---|---|
| Headline | 32 / 23 / 19 | 32 / 23 / 19 | report headings |
| Title | 16 | 16 (title-medium) | app bar, drawer, sheet headers |
| Body | 16 / 14 / 13 | 16 / 14 / 13 | reading and slide text / rows / interface |
| Label large | 12 | 14 (label-large) | chips, primary tabs, the code sheet's title |
| Label | 12 / 11 | 12 / 11 | navigation bar labels / group headings |
| Count | 10 | 10 | badges |

Touch targets are `--rr-touch` (48px); it is the one size token the phone adds.

**The One Layer Rule.** A token that points at another token exists only when it switches value in one place (theme,
typeface, panel, form) or is a public contract (`--rr-text-prose`). Otherwise use the step itself. A phone rule that
re-styles a core selector is a layer too: keep it only where the phone genuinely differs.

## Enforcement

`bun run check` holds most of this file:
- **stylelint** (`stylelint.config.js`): sizes, spacing, weights, letter-spacing and colours only from tokens, on the phone too; no hex
  or `rgb()` outside `tokens.css`; no literal percentage in `color-mix()`; correctness rules (duplicate selectors and
  properties, unknown properties and units); no phone selectors in core CSS.
- **`scripts/css-usage.ts`**: an `rr-` class nothing writes, a `--rr-*` token set outside `tokens.css` (but the
  `--rr-panel` pair), a variable read but never set or set but never read.
- **Layout cases** (`testing/slides/layout.test.ts`): every demo slide is a named case (view, wrap, whole or folded,
  where it sits), checked in a browser.
- **Snapshots** for refactors meant to change nothing: `bun scripts/snapshot.ts` diffs computed styles on a phone and a
  computer, light and dark.

Token layers: (1) `tokens.css`, the scales and palette, the only place `--rr-*` are set; (2) `--rr-panel` and
`--rr-panel-2`, the current surface a panel sets; (3) bridges, a library's own variables (`--pele-*` diagrams,
`--diffs-*` code, `--dv-*` the dock) set from `--rr-*` in that library's CSS. A component's private variable is
`--_name`.

## Do's and Don'ts

### Do
- Do take every colour, size, space, weight and radius from a `--rr-*` token, and derive colours with a
  `--rr-mix-*` step.
- Do keep new surfaces dense: 13px interface text, 28 to 32px controls, 2px corners.
- Do put code, paths and ids in mono, and group headings in sentence case at 600.
- Do separate planes by surface tone; give shadows only to what floats.
- Do reuse the shared components: the file band, the thread mark, the send button, the 36px bar.
- Do check light and dark, at wide and laptop widths, and the phone when shared CSS changes.
- Do give controls whose purpose isn't obvious a `title` (with `data-keys` for a shortcut).

### Don't
- Don't colour links, chips or highlights blue, or use any colour for decoration.
- Don't use tracked capitals for labels, or a filled pill where plain text will do.
- Don't add shadows, gradients or large radii to static surfaces.
- Don't set a `--rr-*` token outside `tokens.css`, or write a literal percentage in `color-mix()`.
- Don't load fonts from the network.
- Don't show raw `rr:` strings, ids or CSS paths as visible text; label them.
- Don't let the report's agent content be rewritten: layer on it with data attributes and overlays.
