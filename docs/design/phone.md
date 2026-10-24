# Phone design: Material 3 Expressive on the Reading Desk

The phone shell (`src/kernel/phone.ts`, `src/kernel/styles/phone.css`; each feature's phone rules in its own
`*.phone.css`, the guided review's player in `src/slides/player.phone.ts`) follows Material 3 Expressive (M3E) for shape,
touch, and motion, and keeps reviewroom's own colour, type, and restraint (`DESIGN.md`). Desktop and the tablet dock
are unchanged; everything here is scoped to `.rr-phone`, the guided review's player to its own `data-form="phone"`. Mock: `docs/design/phone-mock.html`.

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
  fit beside the title at 360px). The other Send buttons (Agent and PR, in the threads list and the composer) are M3E
  filled full pills with their label: Agent `--rr-comment` fill with `--rr-comment-ink`, PR neutral tonal. All flat: no
  key-cap edges, lift or press-in; hover (pointers only) and press are an 8% / 12% state layer of the content colour;
  unavailable is flat and muted (ink at 10% fill, 38% text), not dashed. Dialog buttons are full pills too.
- **Primary tabs** (48px): Inter 14/500, muted; selected is ink with a 3px accent indicator, rounded top corners,
  width of the label, moving with the swipe (elastic, follows the finger). Hairline under the row.
- **Navigation bar** (M3E flexible, 64px + safe-area): 4 items, 24px icons, 12px labels (not bold when selected).
  Active indicator 56×32 full pill in `--rr-accent-soft`, icon in `--rr-accent`. Badges: orange, 16px, top-end of
  the icon. The indicator grows from the centre with the fast spatial spring when switching.
- **Code sheet** (standard bottom sheet): extra-large top corners, drag handle 32×4 in a 24px strip (with the header row under it, 72px drag), header with
  file (mono 13), a line chip, and expand / close icon buttons. Detents: peek 40%, full → becomes the Code area.
  Shadow `--rr-shadow-lg`; no scrim at peek (the text stays usable), scrim only while dragging above 70%.
- **Code area**: files as medium-radius cards on `--rr-surface-well`, 8px apart; sticky file header (surface-container,
  mono 12, `n / N`, chevron); file rail on the trailing edge, 4px wide segments with small radius, 12px when dragged.
- **Search view** (M3E contained): search bar is a 56px full pill on `--rr-surface-nav-2` with leading back arrow and
  trailing clear; filter chips (small radius, 32px) below; results 56px rows with a 24px kind icon, group labels in the
  DESIGN.md uppercase label style. Opens with a container transform from the search icon (standard spatial spring).
- **Drawer** (modal navigation drawer): 300px max, large trailing corners, header with title and facts, 56px items,
  selected item would use a full-pill accent-soft indicator, theme as a segmented button (full pill outer, 3 segments).
- **Guided review**: the code fills the screen; the slide is a large-radius card over it; controls are an M3E floating
  toolbar (full pill, 52px, surface-container-high, the only surface): Back, Contents, Comment and Next are plain 44px
  icon buttons on it, no fills of their own; pressed or hovered, a round 12% / 8% state layer. Back and Next are
  `--rr-ink`; Contents `--rr-ink-2`; Comment is marked only by its `chat` icon's `--rr-comment` stroke. On the first
  slide Back is disabled (muted), on the last Next is ("Last slide"): the close in the top bar ends the walkthrough. No
  blue, no pulse. Contents (and the chapter title in the top bar) opens a bottom sheet of the chapters with their
  slide counts, the current one expanded to its slides; Back or the scrim closes it. Immersive:
  4 s untouched (not while a menu, the composer, the Contents sheet or a selection is open), the top bar and the
  toolbar fade, the code fills the screen edge to edge and the card drops to just above the progress row with a small
  Show controls icon in its corner, the only thing that brings them back: swipes, slide changes, card drags,
  scrolling and taps keep it immersive. The installed app is full screen (manifest `display: fullscreen`: no
  status or navigation bar, content under a cutout too, no exit notice). In a browser tab the guided review asks for it
  (the Fullscreen API) on the opening tap and any later one; after Back leaves full screen, only reopening asks again. The Show controls icon has an edge and a shadow so it reads over code or prose. Reduced
  motion: they fade, nothing moves. The card is a bottom sheet with three detents, kept across slides: collapsed (grip
  and the text's first two lines), default (its content, up to 40% of the screen) and tall (up to all but the bar and a
  strip of code). Dragging the grip or the card follows the finger and settles on the nearest detent, a flick at least
  one step; the text scrolls once tall, and a drag down from its top shrinks it. Sideways swipes change the slide. The
  chapter intro opens its first slide; on the others it folds to its first line with More, and a swipe up (or a tall
  card) opens it. The code is one sheet on the code surface to the bottom edge. The walkthrough's progress (chapters ×
  slides) is a thin row at the screen's foot, always shown.
- **Guided review on its side**: the phone player goes by the device (`usesPhonePlayer()` in `src/kernel/device.ts`: a
  phone either way up, or `?phone`), not the shell, so a turned phone keeps it under the dock; tablets and computers get
  the desktop player. It marks itself `data-form="phone"` and `data-orient` (the viewport's, live), and its styles key
  off those. Landscape: the slide is a column on the left, the code on the right edge to edge, the desktop's draggable
  divider between them (half and half by default); the toolbar floats at the foot of the code, centred on it; the top
  bar folds away when immersive and Show controls sits in the screen's top-right corner. The rest (immersive, toolbar,
  swipes, Contents) is the same; the card's detents are portrait only.
- **Rotation**: a phone on its side gets the dock (from the Tablet layout, never saved over the reviewer's last
  layout); upright, the phone shell. It reloads into the other shell on rotation, keeping the panel in front, the open
  file and the slide (`src/kernel/device.ts`); the guided review comes back in the other orientation's variant.
- **Composer**: extra-large top corners, sits on `--rr-kb`; text field medium radius with accent focus outline.
- **Toast** (snackbar): medium radius, inverse surface (`--rr-ink` fill, `--rr-bg` text), action in
  `--rr-accent-soft`; sits above the navigation bar.

## Icons

24px on phones, drawn on the 16px grid of `src/kernel/dom.ts` (same stroke style, `stroke-width` 1.4 → renders ~2px).
No emoji. Additions to the set: `menu`, `back`, `home` (all reviews), `book` (Read), `refresh`, `theme` (half
circle), `info`, `more`, `chat` (Comment: a rounded bubble with a tail and three dots). Selected nav icons stay outlined (minimal); the indicator carries the state.

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
