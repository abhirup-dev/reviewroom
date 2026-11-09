---
version: alpha
name: reviewroom
description: A local workbench for reading a diff with an agent's walkthrough beside it. Warm paper and quiet tooling, square and dense, with colour kept for meaning.
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
  accent: "#2557d6"
  accent-soft: "#e8eefc"
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
  dark-accent: "#7aa2f7"
  dark-comment: "#f0a35e"
  dark-pin: "#f07ad8"
  dark-add: "#8fc9a3"
  dark-del: "#e49ab0"
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
  rail-width: 232px
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

**Creative North Star: "The Reading Desk."** Warm paper on a desk. The agent's walkthrough is the document; files,
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
  Threads; `surface-doc` for the walkthrough and thread windows; `surface-code` for code; `surface-bar` and
  `surface-bar-active` for tab bars and toolbars; `surface-overlay` for menus, dialogs and the palette.
- **Hairlines** (`line`, `line-strong`): borders, dividers, guide lines; strong for control outlines and active guides.
- **Blue** (`accent`): focus rings, the walkthrough's progress and the current position. Never links or highlights.
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
**The Meaning Rule.** Orange is talk, magenta is pinned, blue is focus or progress, green and red are the diff or
state. Nothing is coloured for decoration.

**The Ink Link Rule.** A link is ink at medium weight over a faint 2px underline that firms up on hover. In a diagram
the label is medium weight with a drawn faint underline (SVG text takes no underline colour).

## Typography

**Text:** Inter, for both the walkthrough's prose and the interface.
**Headings:** Mona Sans (GitHub's face), 600, slightly tightened; h1 and h2 sit on a hairline, as in a GitHub README.
**Code:** the system monospace (SF Mono on a Mac), for code, paths, ids and identifiers.

A reader can switch to the classic set (Typography: classic serif): Source Serif 4 for the walkthrough, Inter for the
interface, JetBrains Mono for code, no heading rules. Inter, Mona Sans and the classic faces are bundled; nothing loads
from the network.

### Hierarchy
- **Headline** (Mona Sans 600): h1 32px, h2 23px, h3 19px. The guided walkthrough's chapter title is an h3.
- **Lede** (19px, `ink-2`): a walkthrough's opening paragraph.
- **Body** (16px / 1.5): the walkthrough. **Comments** 14px. **Interface** 13px: controls, rows, lists.
- **Label** (12px): tabs, group headings and toolbar titles at 600, in sentence case. Segments and chips at 500.
- **Small** (11px): metadata, round tags (`R2`, mono, semibold, no fill), the unread tag (dark red, semibold).
- **Count** (10px, 600): numbers inside a fixed box.
- **Code** 12.5px in the code panel, 12px in snippets.

### Named rules
**The Sentence Case Rule.** Labels and group headings are sentence case at 600 in `ink-2`. No tracked capitals in the
desktop interface (the guided walkthrough's "SLIDE 1 OF 4" divider is the one small-caps label).

**The Type Scale Rule.** Every font size is a `--rr-text-*` step (10, 11, 12, 13, 14, 16, 19, 23, 32px) or relative
to its context (em, %). Weights are 400, 500 and 600.

## Layout

A 52px header (`chrome`) over docked panels. Every bar of tools (the dock's tab bars, the code panel's toolbar, a
floating window's title bar) is 36px with 8px padding at its ends and 6px between controls. A file's band, its status,
path, size and Viewed above its code, is 38px and is the same component in the code panel and the walkthrough.

Panels pick their surface by kind (`data-rr-kind`): navigation on `surface-nav`, the walkthrough and threads on
`surface-doc`, code on `surface-code`. A component paints `--rr-panel` and `--rr-panel-2`, which the panel holding it
sets, so it fits any panel. The walkthrough column is capped at 760px, and the thread rail beside it is 232px.

Spacing is a fixed scale: 2px steps up to 12 for dense controls (2, 4, 6, 8, 10, 12), then 16, 24, 32, 48 for layout.
Trees indent 14px per level.

**The guided walkthrough** is a two-column player: narration on `surface-doc` at about a third of the width
(draggable), code the rest, full height. The chapter heading belongs to the narration column and is exactly as tall
as the code's toolbar plus its file band (`--rr-bar-h + --rr-band-h`), so a slide's first line starts level with the
code's first line, whether or not the chapter has an intro.

**Contents** follows the reader: the section and headings down to the one being read are bold, that last one is
underlined, and its guide lines firm up. Pinned entries sit at the top without a heading; the Walkthrough group has a
heading over a full-width hairline, its entries flush with the heading.

## Elevation & Depth

Flat at rest. Depth comes from tonal planes: chrome, then navigation, then paper. Shadows appear only on layers that
float above the page.

- **Small** (`--rr-shadow-sm`): a slight lift for cards inside a panel, the block handle.
- **Floating** (`--rr-shadow`): menus, hover cards, tooltips.
- **Modal** (`--rr-shadow-lg`) over a `--rr-scrim` backdrop: dialogs, the palette, the guided walkthrough player.

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
18px with larger numbers in the walkthrough, the guided walkthrough and the code. Orange for the agent, `ink-2` for
GitHub, grey once resolved. In the Threads list the mark sits at the right end of the row, after the round tag; the
icon before the location (the walkthrough's page, code's brackets) says what the thread is on, so the list has no group
headings. "unread" (dark red, semibold) marks a thread the agent answered this round.

### Pins
A block pinned to Contents shows a small magenta pin after its text; a pinned section shows it after its heading.
Pinning a heading that opens a section pins the section.

### Link previews
Hovering a link for 400ms opens its preview; it closes 200ms after the pointer leaves the link and the card, and at
once on any scroll. A scroll moving content under a still pointer doesn't count as hovering.

### Walkthrough block actions
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
| Headline | 32 / 23 / 19 | 32 / 23 / 19 | walkthrough headings |
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
- **e2e** (`e2e/slides.test.ts`): the guided walkthrough's narration starts level with the code, with or without a
  chapter intro.
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
- Don't let the walkthrough's agent content be rewritten: layer on it with data attributes and overlays.
