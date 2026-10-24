import { afterAll, afterEach, expect, test } from 'bun:test';
import { installDOM } from '../testing/dom';

const dom = installDOM();
afterAll(() => dom.restore());
const { composer } = await import('./view.ts');
const { EditorView } = await import('@codemirror/view');
const composers: ReturnType<typeof composer>[] = [];
afterEach(() => { for (const c of composers.splice(0)) c.el.querySelectorAll<HTMLElement>('.cm-editor').forEach(e => EditorView.findFromDOM(e)?.destroy()); });

/** Load `md` into a composer and return what it shows and what it would save. */
const roundTrip = (md: string) => {
  let saved = '';
  const c = composer({ label: (r: string) => `label of ${r}`, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: (b) => void (saved = b) }], initial: md });
  composers.push(c);
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
  const open = () => { const c = composer({ label: (r: string) => r, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: () => {} }], draftKey: key, onCancel: () => {} }); composers.push(c); return c; };
  localStorage.setItem(key, 'half a thought');
  const c = open();
  expect(c.el.querySelector('.rr-composer__input')!.textContent).toBe('half a thought');
  c.el.querySelector('.cm-content')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(localStorage.getItem(key)).toBe('half a thought');
  [...open().el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
  expect(localStorage.getItem(key)).toBe(null);
});
