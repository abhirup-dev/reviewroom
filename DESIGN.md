---
name: reviewroom
description: A local workbench for reading a diff with an agent's walkthrough beside it.
colors:
  accent: "#2557d6"
  accent-soft: "#e8eefc"
  comment: "#b4570f"
  comment-soft: "#fdf0e1"
  chrome: "#e4e2db"
  surface-nav: "#f2f1ec"
  surface-nav-2: "#e9e7e1"
  surface-doc: "#ffffff"
  surface-doc-2: "#f6f5f1"
  surface-code: "#fdfdfc"
  surface-bar: "#ebe9e3"
  surface-overlay: "#ffffff"
  ink: "#1b1a17"
  ink-2: "#3d3b36"
  muted: "#67635b"
  faint: "#8d897f"
  line: "#e4e1d9"
  line-strong: "#d3cfc5"
  ok: "#1a7f37"
  ok-soft: "#e4f4e8"
  warn: "#a35c00"
  warn-soft: "#fff3dc"
  risk: "#b42318"
  risk-soft: "#fdecea"
  add: "#1a7f37"
  del: "#c2402a"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  prose:
    fontFamily: "'Source Serif 4', 'Iowan Old Style', Charter, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.06em"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
rounded:
  sm: "2px"
  md: "2px"
  lg: "4px"
spacing:
  header: "52px"
  bar: "36px"
  row: "32px"
  doc-width: "760px"
  rail-width: "232px"
components:
  button:
    backgroundColor: "{colors.surface-overlay}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.chrome}"
    rounded: "{rounded.md}"
    height: "32px"
  button-small:
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  pill:
    backgroundColor: "{colors.surface-overlay}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "0 7px"
    height: "20px"
  pill-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
  pill-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  chip:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "0 7px"
    height: "22px"
  input:
    backgroundColor: "{colors.surface-overlay}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  badge:
    backgroundColor: "{colors.comment}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    height: "18px"
---

# Design System: reviewroom

Source of truth for values is `src/kernel/styles/tokens.css` (`--rr-*`). This file explains how to use them; when the two
disagree, the CSS wins and this file is stale. Dark values live under `[data-rr-theme="dark"]` in the same file.

## Overview

**Creative North Star: "The Reading Desk"**

Warm paper on a desk. The walkthrough is a serif document on white, and everything else (files, threads, toolbars) is
quiet tooling arranged around it on slightly darker, warmer planes. Reading comes first; the interface earns attention
only where the reviewer has to act.

The system is dense and square: 13px interface text, 32px rows, 2px corners, hairline borders. It reads like a
well-made engineering tool, not a consumer app. Colour is scarce and semantic: blue means "go there", orange means
"a conversation", green/amber/red mean state. Dark mode is near-black with blue-grey surfaces and pastel diff colours,
so long sessions stay calm.

**Key Characteristics:**
- Three voices: serif for reading, Inter for the interface, JetBrains Mono for code, paths and ids.
- Surfaces separate by tone, not shadow; shadows belong to floating layers only.
- Square corners everywhere (2px), 4px only on things that float.
- One tactile exception: the Send buttons are raised key caps.
- No network fonts; all three families ship with the tool.

## Colors

A warm neutral paper palette with one blue accent and one orange conversational colour.

### Primary
- **Ink Blue** (accent): links, `rr:` chips, focus rings, the selected item. The only colour that means "navigate".

### Secondary
- **Margin Orange** (comment): threads, comment highlights, the Agent send button, unread badges. It marks
  conversation, never navigation.

### Neutral
- **Desk Chrome** (chrome): the app header, the ground behind the docked panels.
- **Notebook** (surface-nav, surface-nav-2): navigation panels (contents, files, threads) and their inputs/hovers.
- **Paper** (surface-doc, surface-doc-2): the walkthrough and figures inside it.
- **Code Sheet** (surface-code): the code panel.
- **Tab Bar** (surface-bar): panel tab bars.
- **Overlay White** (surface-overlay): menus, dialogs, palette, popovers.
- **Ink** (ink, ink-2): primary and secondary text; also the primary button fill.
- **Pencil** (muted, faint): metadata, captions, group labels, placeholders.
- **Hairline** (line, line-strong): borders and dividers; strong for control outlines.

### State
- **ok / warn / risk** with their `-soft` backgrounds: approved, draft or caution, failure or risk. Always as a soft
  fill plus coloured text, never a saturated block.

### Named Rules
**The Two Signals Rule.** Blue is for going somewhere, orange is for talking. Don't use either for decoration or for state.

**The Token-Only Rule.** Colours come only from `--rr-*` tokens. Hover and active fills are the translucent
`--rr-hover` / `--rr-active` so they work on every surface.

## Typography

**Display Font:** none; the walkthrough's own headings are the largest type.
**Body Font:** Inter (with ui-sans-serif, system-ui)
**Reading Font:** Source Serif 4 (with Iowan Old Style, Charter, Georgia)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SF Mono, Menlo)

**Character:** A literary serif for the agent's explanation against a neutral, compact sans for the tool; mono marks
anything machine-addressable.

### Hierarchy
- **Title** (600, 14px): the review title in the header; dialog titles.
- **Body** (400–500, 13px, 1.45): all interface text, buttons, rows, thread messages.
- **Small** (12px) and **XS** (11px): secondary controls, metadata, hints.
- **Prose** (400, 16px, 1.6, max 760px): the walkthrough only.
- **Label** (600, 10.5px, 0.06em, uppercase, faint): group headings in lists and panels.
- **Mono** (11–12px): file paths, shas, pids, ports, line numbers, keyboard hints.

### Named Rules
**The Serif-Is-Reading Rule.** Source Serif appears only in the walkthrough and walkthrough previews. Interface
surfaces, including dashboards and tables, are Inter.

## Layout

A fixed 52px header over docked panels (dockview). Panel tab bars and toolbars are 36px; list rows are about 32px;
small controls 26px. Panels choose their surface by kind (`data-rr-kind`): navigation panels on Notebook, the
walkthrough on Paper, code on Code Sheet. The walkthrough column is capped at 760px; side rails are about 232px.
Spacing steps are small and even (4, 6, 8, 12, 14px). The header reads as one quiet line of facts separated by a faint
`·`, not a row of badges.

## Elevation & Depth

Flat at rest. Depth comes from tonal layering: chrome, then navigation, then paper. Shadows appear only on layers that
float above the page.

### Shadow Vocabulary
- **Small** (`--rr-shadow-sm`): a slight lift for cards inside a panel.
- **Floating** (`--rr-shadow`): menus, hover cards, tooltips.
- **Modal** (`--rr-shadow-lg`) with `--rr-scrim` backdrop: dialogs and the command palette.

### Named Rules
**The Float-Only Shadow Rule.** If it doesn't float (menu, popover, dialog), it has no shadow.

## Shapes

Square. 2px radius on chips, buttons, inputs, cards and blocks; 4px on floating layers (menus, dialogs, palette,
popovers). 1px hairline borders define controls and separate rows; strong hairlines outline buttons. Nothing is pill-
shaped or fully rounded.

## Components

### Buttons
Quiet, square, outlined.
- **Default:** 32px tall, 12px side padding, strong hairline border, current-surface fill, 500 weight.
- **Hover:** translucent hover fill; no colour change. **Disabled:** 50% opacity.
- **Primary:** Ink fill with chrome-coloured text; hover lightens to ink-2.
- **Ghost:** no border, no fill until hover. **Small:** 26px, 8px padding, 12px text.
- **Icon button:** 26px square, muted icon, hover fill; pressed state uses the active fill.
- **Send (signature):** the one tactile control. A raised key cap with a lit top edge, a darker 2px bottom edge and a
  soft shadow; lifts 1px on hover and presses in on click. Orange for Agent, neutral for PR. When unavailable it
  becomes flat and dashed.

### Pills and badges
- **Pill:** 20px, hairline border, muted text, 11px; `--mono` for ids. State variants (ok, draft, accent) drop the
  border and use soft fill plus coloured text.
- **Badge:** orange count, 18px, white 600 11px text.

### Chips (`rr:` refs)
22px, accent-soft fill, accent text, hairline border that turns accent on hover. Mono when the target is code, a file or
a symbol.

### Inputs
28px, hairline border, current-surface fill. Focus: accent border plus a 2px accent-soft outline. Segmented controls
share one hairline frame with dividers; the selected segment uses the active fill.

### Lists and navigation
Rows about 32px with hover fill; selection uses the active fill. Groups are introduced by the uppercase faint label.
Tabs are underlined: muted text, ink text and a 2px ink underline when on.

### Floating layers
Menus (30px items), palette (48px input, 34px items with a small kind glyph, a hint bar), dialogs: Overlay White,
hairline border, 4px radius, shadow from the vocabulary above. They enter with a short fade/pop (0.12–0.14s ease-out).

## Do's and Don'ts

### Do:
- **Do** take every colour, font and radius from `--rr-*` tokens.
- **Do** keep new surfaces dense: 13px text, about 32px rows, 2px corners.
- **Do** put ids, paths, pids and ports in mono, and group headings in the uppercase label style.
- **Do** separate planes by surface tone; use shadows only on floating layers.
- **Do** check light and dark, at wide and laptop widths.
- **Do** give controls whose purpose isn't obvious a `title` (with `data-keys` for a shortcut).

### Don't:
- **Don't** use blue or orange decoratively, or for state.
- **Don't** add shadows, gradients or large radii to static surfaces; the Send key cap is the only raised control.
- **Don't** use the serif outside the walkthrough.
- **Don't** load fonts from the network.
- **Don't** show raw `rr:` strings, ids or CSS paths as visible text; label them.
