// The design system, enforced: sizes, spacing, weights, tracking and colour in src/**/*.css come from the tokens in
// src/kernel/styles/tokens.css (or are relative: em, %), the phone's CSS included. A deliberate exception carries a
// stylelint-disable comment saying why.
export default {
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
        // derived colours: a step of var(--rr-mix-*), not a literal percentage
        '/./': ['/color-mix\\((?:[^()]|\\([^()]*\\))*\\d%/'],
      },
      { message: (prop, value) => `"${prop}: ${value}" is off the design scale: use a token from src/kernel/styles/tokens.css` },
    ],
    'declaration-property-value-allowed-list': [
      { 'letter-spacing': ['0', 'normal', '/^var\\(--rr-tracking-/'] },
      { message: (prop, value) => `"${prop}: ${value}": use var(--rr-tracking-*)` },
    ],
    // the phone's looks live in its own CSS (phone.css, *.phone.css): no phone selectors in the core's (rr-486)
    'selector-disallowed-list': [[/\.is-phone\b/, /\[data-form=['"]?phone/], { message: (s) => `"${s}" styles the phone: put it in the phone CSS (phone.css, *.phone.css)` }],
    // correctness: what a typo or a leftover leaves behind
    'block-no-empty': true,
    'declaration-block-no-duplicate-properties': [true, { ignore: ['consecutive-duplicates-with-different-syntaxes'] }],
    'declaration-block-no-duplicate-custom-properties': true,
    'declaration-block-no-shorthand-property-overrides': true,
    'no-duplicate-selectors': true,
    'property-no-unknown': true,
    'selector-pseudo-class-no-unknown': true,
    'selector-pseudo-element-no-unknown': true,
    'selector-type-no-unknown': [true, { ignore: ['custom-elements'] }],
    'unit-no-unknown': true,
    'function-no-unknown': true,
    'custom-property-no-missing-var-function': true,
    'no-invalid-double-slash-comments': true,
    'at-rule-no-unknown': true,
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
  },
  overrides: [
    // the palette itself
    { files: ['src/kernel/styles/tokens.css', 'src/kernel/styles/tokens.phone.css'], rules: { 'color-no-hex': null, 'function-disallowed-list': null } },
    { files: ['src/**/*.phone.css', 'src/kernel/styles/phone.css'], rules: { 'selector-disallowed-list': null } },
  ],
};
