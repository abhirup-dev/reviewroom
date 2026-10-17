import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

const w = new JSDOM('', { url: 'http://localhost/', pretendToBeVisual: true }).window;
Object.assign(globalThis, { window: w, Window: w.Window, document: w.document, navigator: w.navigator, localStorage: w.localStorage, customElements: w.customElements, HTMLElement: w.HTMLElement, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle, requestAnimationFrame: () => 0 });
const { composer } = await import('./thread.ts');

/** Load `md` into a composer and return what it shows and what it would save. */
const roundTrip = (md: string) => {
  let saved = '';
  const c = composer({ label: (r: string) => `label of ${r}`, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: (b) => void (saved = b) }], initial: md });
  (c.el.querySelector('.rr-btn') as HTMLElement).click();
  return { shown: c.el.querySelector('.rr-composer__input')!.textContent, saved };
};

test('rr: links show as chips and save as the same markdown', () => {
  const md = 'see [a.go:1-2](rr:code/a.go#L1-2) and **this**\n\n![Request path](rr:doc/request-path)\n\n```go\nx := `1`\n```';
  const { shown, saved } = roundTrip(md);
  expect(shown).toContain('a.go:1-2');
  expect(shown).not.toContain('rr:');
  expect(saved).toBe(md);
});

test('saved markdown: labels lose brackets, embeds get their own line, empty labels get a name', () => {
  expect(roundTrip('[a[b](rr:code/a.go) x ![e](rr:doc/s) y\n\n\n\nz\u00a0').saved).toBe('[ab](rr:code/a.go) x \n![e](rr:doc/s)\n y\n\nz');
  expect(roundTrip('[](rr:code/a.go)').saved).toBe('[label of rr:code/a.go](rr:code/a.go)');
});

test('Cancel throws the draft away; Esc keeps it for next time', () => {
  const key = 'reviewroom:draft:test';
  const open = () => composer({ label: (r: string) => r, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: () => {} }], draftKey: key, onCancel: () => {} });
  localStorage.setItem(key, 'half a thought');
  const c = open();
  expect(c.el.querySelector('.rr-composer__input')!.textContent).toBe('half a thought');
  c.el.querySelector('.cm-content')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(localStorage.getItem(key)).toBe('half a thought');
  [...open().el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
  expect(localStorage.getItem(key)).toBe(null);
});
