// The design system, enforced: sizes, spacing, weights, tracking and colour in src/**/*.css come from the tokens in
// src/kernel/styles/tokens.css (or are relative: em, %). A deliberate exception carries a stylelint-disable comment
// saying why. `ignoreFiles` is a ratchet like the oxlint overrides: the phone CSS awaits its own pass; files only come off.
export default {
  ignoreFiles: [
    'src/kernel/styles/phone.css',
    'src/kernel/styles/tokens.phone.css',
    'src/review/styles/review.phone.css',
    'src/threads/styles/threads.phone.css',
    'src/slides/styles/slides.phone.css',
  ],
  reportNeedlessDisables: true,
  rules: {
    'declaration-property-value-disallowed-list': [
      {
        // spacing: var(--rr-space-*); 0 and 1px hairlines are fine
        '/^(padding|margin|gap|row-gap|column-gap)/': ['/(^|[^\\w.-])([2-9]|\\d{2,})(\\.\\d+)?px/', '/\\d\\.\\d+px/', '/\\d(rem|pt)/'],
        // type: var(--rr-text-*), var(--rr-read-*), or relative to the context
        'font-size': ['/\\d(px|rem|pt)/'],
        font: ['/(?<!\\/\\s*)(^|\\s)\\d+(\\.\\d+)?(px|rem|pt)\\b/'],
        'font-weight': ['/^(100|200|300|700|800|900|bold|bolder|lighter)$/'],
      },
      { message: (prop, value) => `"${prop}: ${value}" is off the design scale: use a token from src/kernel/styles/tokens.css` },
    ],
    'declaration-property-value-allowed-list': [
      { 'letter-spacing': ['0', 'normal', '/^var\\(--rr-tracking-/'] },
      { message: (prop, value) => `"${prop}: ${value}": use var(--rr-tracking-*)` },
    ],
    // the phone's looks live in its own CSS (phone.css, *.phone.css): no phone selectors in the core's (rr-486)
    'selector-disallowed-list': [[/\.is-phone\b/, /\[data-form=['"]?phone/], { message: (s) => `"${s}" styles the phone: put it in the phone CSS (phone.css, *.phone.css)` }],
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
  },
  overrides: [
    // the palette itself
    { files: ['src/kernel/styles/tokens.css'], rules: { 'color-no-hex': null, 'function-disallowed-list': null } },
    { files: ['src/**/*.phone.css', 'src/kernel/styles/phone.css'], rules: { 'selector-disallowed-list': null } },
  ],
};
