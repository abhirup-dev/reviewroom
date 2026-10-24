# Phone design: Material 3 Expressive on the Reading Desk

The phone shell (`src/kernel/phone.ts`, `src/kernel/styles/phone.css`) follows Material 3 Expressive (M3E) for shape,
touch, and motion, and keeps reviewroom's own colour, type, and restraint (`DESIGN.md`). Desktop and the tablet dock
are unchanged; everything here is scoped to `.rr-phone`. Mock: `docs/design/phone-mock.html`.

## The deal between the two systems

| From M3 Expressive                                  | From reviewroom (`DESIGN.md`)                                 |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Shape scale, rounded touch surfaces, pill indicators | Colours: `--rr-*` tokens only, light and dark                 |
| Flexible navigation bar, primary tabs, sheets        | Two Signals: blue = go somewhere, orange = conversation       |
| Search view, floating toolbar, modal drawer          | Three voices: Inter UI, Source Serif prose, JetBrains Mono code |
| Spring motion, 48px touch targets                    | Flat at rest; shadow only on things that float                |

**Minimal means:** one accent, no FAB, no gradients, no dynamic colour, no shape morphing for decoration. Expressive
moments are limited to three: the nav indicator, the code sheet, and the guided-review toolbar.

## Colour roles (M3 role → token)

| M3 role                         | Light / dark token                 | Used for                                      |
| ------------------------------- | ---------------------------------- | --------------------------------------------- |
| surface-container (bars)        | `--rr-bg`                          | top app bar, navigation bar                   |
| surface (content)               | `--rr-surface-doc` / `-nav` / `-code` | pages by kind, as on desktop               |
| surface-container-high          | `--rr-surface-overlay`             | sheets, drawer, search view, menus            |
| secondary-container (indicator) | `--rr-accent-soft`                 | nav indicator, selected row, active chip      |
| on-secondary-container          | `--rr-accent`                      | icon and label on the indicator               |
| primary (filled button)         | `--rr-ink` on `--rr-bg` text       | Send, primary actions (DESIGN.md: ink fill)   |
| tertiary (conversation)         | `--rr-comment`, `--rr-comment-soft` | thread badge, unsent count, comment marks    |
| outline-variant                 | `--rr-line`                        | dividers, chip outlines                       |
| scrim                           | `--rr-scrim`                       | behind drawer, modal sheet, search            |

## Shape (M3 shape scale, phone only)

| Token          | Radius | Where                                                        |
| -------------- | ------ | ------------------------------------------------------------ |
| extra-small    | 4px    | code `rr:` chips, inline marks, line highlight               |
| small          | 8px    | filter chips, file rail segments, small buttons              |
| medium         | 12px   | cards (threads), menu, file jump list, toast                 |
| large          | 16px   | drawer trailing corners, guided-review slide card            |
| extra-large    | 28px   | sheet top corners (code sheet, composer)                     |
| full           | 50%    | nav indicator (56×32), search bar, icon buttons, Send, badges |

Desktop keeps 2px. The phone breaks the square rule on purpose: thumbs need soft, large targets.

## Components

- **Top app bar** (small, 64px): menu icon button · title (Inter 16/600, one line) with `repo · Round N` (12px,
  muted) · search · play (only with a walkthrough) · Send. Flat; gains a hairline only when content scrolls under it.
- **Send**: the one filled control in the bar: a 48px round icon button, ink fill, `send` icon, `title` "Send
  round"; unsent count as an orange badge on its corner. The desktop key cap becomes this on phones (a label doesn't
  fit beside the title at 360px).
- **Primary tabs** (48px): Inter 14/500, muted; selected is ink with a 3px accent indicator, rounded top corners,
  width of the label, moving with the swipe (elastic, follows the finger). Hairline under the row.
- **Navigation bar** (M3E flexible, 64px + safe-area): 4 items, 24px icons, 12px labels (not bold when selected).
  Active indicator 56×32 full pill in `--rr-accent-soft`, icon in `--rr-accent`. Badges: orange, 16px, top-end of
  the icon. The indicator grows from the centre with the fast spatial spring when switching.
- **Code sheet** (standard bottom sheet): extra-large top corners, drag handle 32×4 in a 48px touch strip, header with
  file (mono 13), a line chip, and expand / close icon buttons. Detents: peek 40%, full → becomes the Code area.
  Shadow `--rr-shadow-lg`; no scrim at peek (the text stays usable), scrim only while dragging above 70%.
- **Code area**: files as medium-radius cards on `--rr-surface-well`, 8px apart; sticky file header (surface-container,
  mono 12, `n / N`, chevron); file rail on the trailing edge, 4px wide segments with small radius, 12px when dragged.
- **Search view** (M3E contained): search bar is a 56px full pill on `--rr-surface-nav-2` with leading back arrow and
  trailing clear; filter chips (small radius, 32px) below; results 56px rows with a 24px kind icon, group labels in the
  DESIGN.md uppercase label style. Opens with a container transform from the search icon (standard spatial spring).
- **Drawer** (modal navigation drawer): 300px max, large trailing corners, header with title and facts, 56px items,
  selected item would use a full-pill accent-soft indicator, theme as a segmented button (full pill outer, 3 segments).
- **Guided review**: content full-screen; the slide is a large-radius card; controls are an M3E floating toolbar
  (full pill, 64px, surface-container-high) with Back · Comment · Next; Next is a filled ink pill.
- **Composer**: extra-large top corners, sits on `--rr-kb`; text field medium radius with accent focus outline.
- **Toast** (snackbar): medium radius, inverse surface (`--rr-ink` fill, `--rr-bg` text), action in
  `--rr-accent-soft`; sits above the navigation bar.

## Icons

24px on phones, drawn on the 16px grid of `src/kernel/dom.ts` (same stroke style, `stroke-width` 1.4 → renders ~2px).
No emoji. Additions to the set: `menu`, `back`, `home` (all reviews), `book` (Read), `refresh`, `theme` (half
circle), `info`, `more`. Selected nav icons stay outlined (minimal); the indicator carries the state.

## Motion (springs as CSS `linear()`)

| Use                                        | Spring (damping / stiffness) | CSS                                 |
| ------------------------------------------ | ---------------------------- | ----------------------------------- |
| Tab pager snap, nav indicator, search open | standard fast 0.9 / 1400     | `--rr-m-fast`, 200ms                |
| Sheets, drawer, page transitions           | standard default 0.9 / 700   | `--rr-m-default`, 280ms             |
| Code sheet → Code area, slide card in      | expressive default 0.8 / 380 | `--rr-m-expressive`, 480ms (slight overshoot) |
| Fades, colour, opacity                     | effects (no overshoot)       | 150ms ease-out                      |

```css
--rr-m-fast: linear(0, 0.067, 0.174, 0.296, 0.418, 0.53, 0.646, 0.726, 0.791, 0.843, 0.883, 0.915, 0.939, 0.957, 0.97, 0.98, 0.986, 0.991, 0.995, 0.997, 0.999, 0.999, 1, 1, 1);
--rr-m-default: linear(0, 0.058, 0.16, 0.279, 0.4, 0.513, 0.613, 0.697, 0.768, 0.824, 0.869, 0.904, 0.931, 0.949, 0.964, 0.976, 0.984, 0.99, 0.994, 0.996, 0.998, 0.999, 1, 1, 1);
--rr-m-expressive: linear(0, 0.077, 0.223, 0.388, 0.544, 0.679, 0.786, 0.867, 0.925, 0.964, 0.988, 1.003, 1.01, 1.013, 1.013, 1.011, 1.009, 1.007, 1.005, 1.004, 1.002, 1.001, 1.001, 1, 1);
```

Curves come from the Compose Material 3 motion tokens (`StandardMotionTokens`, `ExpressiveMotionTokens`), sampled by
a mass-1 spring. After a drag, start the settle from the finger's velocity where practical. Under
`prefers-reduced-motion`, replace movement with a 150ms fade.

## Touch

48px minimum targets; 8px between adjacent targets. Horizontal swipes start only after 10px of mostly-horizontal
travel and never inside code, selection, or a long-press. Back (`popstate`) closes the topmost layer first.

## Sources

- Material Components Android, M3 Expressive styles: navigation bar (64dp bar, 56dp indicator width, 32dp height,
  full rounding), floating toolbar, search view (contained style), bottom sheets, tabs.
- Jetpack Compose Material 3: `ShapeTokens` (4/8/12/16/28/32/48dp, full), `StandardMotionTokens`,
  `ExpressiveMotionTokens` (spring damping and stiffness).
- m3.material.io, "Building with M3 Expressive".
