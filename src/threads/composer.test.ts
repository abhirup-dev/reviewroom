import { afterAll, afterEach, expect, test } from 'bun:test';
import { installDOM } from '../testing/dom';

const dom = installDOM();
afterAll(() => dom.restore());
const { composer } = await import('./view.ts');
const { EditorView } = await import('@codemirror/view');
const composers: ReturnType<typeof composer>[] = [];
afterEach(() => { for (const c of composers.splice(0)) c.el.querySelectorAll<HTMLElement>('.cm-editor').forEach(e => EditorView.findFromDOM(e)?.destroy()); });

/** Load `md` into a composer and return what it shows and what it would save. */
const roundTrip = async (md: string) => {
  let saved = '';
  const c = composer({ label: (r: string) => `label of ${r}`, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: (b) => void (saved = b) }], initial: md });
  composers.push(c);
  await c.ready; // the editor is its own chunk (editor.ts)
  (c.el.querySelector('.rr-btn') as HTMLElement).click();
  return { shown: c.el.querySelector('.rr-composer__input')!.textContent, saved };
};

// first in the file: later composers find the editor already loaded
test('text typed before the editor arrives moves into it, caret and all', async () => {
  const c = composer({ label: (r: string) => r, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: () => {} }] });
  composers.push(c);
  const stand = c.el.querySelector('textarea')!;
  stand.value = 'typed early';
  stand.setSelectionRange(5, 5);
  await c.ready;
  expect(c.el.querySelector('textarea')).toBe(null);
  const view = EditorView.findFromDOM(c.el.querySelector('.cm-editor')!)!;
  expect([view.state.doc.toString(), view.state.selection.main.head]).toEqual(['typed early', 5]);
});

test('once the editor has loaded, a new composer has it at once', () => {
  const c = composer({ label: (r: string) => r, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: () => {} }] });
  composers.push(c);
  expect([!!c.el.querySelector('.cm-editor'), c.el.querySelector('textarea')]).toEqual([true, null]);
});

test('rr: links show as chips and save as the same markdown', async () => {
  const md = 'see [a.go:1-2](rr:code/a.go#L1-2) and **this**\n\n![Request path](rr:doc/request-path)\n\n```go\nx := `1`\n```';
  const { shown, saved } = await roundTrip(md);
  expect(shown).toContain('a.go:1-2');
  expect(shown).not.toContain('rr:');
  expect(saved).toBe(md);
});

test('saved markdown: labels lose brackets, embeds get their own line, empty labels get a name', async () => {
  expect((await roundTrip('[a[b](rr:code/a.go) x ![e](rr:doc/s) y\n\n\n\nz\u00a0')).saved).toBe('[ab](rr:code/a.go) x \n![e](rr:doc/s)\n y\n\nz');
  expect((await roundTrip('[](rr:code/a.go)')).saved).toBe('[label of rr:code/a.go](rr:code/a.go)');
});

test('Cancel throws the draft away; Esc keeps it for next time', async () => {
  const key = 'reviewroom:draft:test';
  const open = () => { const c = composer({ label: (r: string) => r, selection: null } as never, { placeholder: 'Reply', buttons: [{ label: 'Send', onSubmit: () => {} }], draftKey: key, onCancel: () => {} }); composers.push(c); return c; };
  localStorage.setItem(key, 'half a thought');
  const c = open();
  await c.ready;
  expect(c.el.querySelector('.rr-composer__input')!.textContent).toBe('half a thought');
  c.el.querySelector('.cm-content')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(localStorage.getItem(key)).toBe('half a thought');
  [...open().el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
  expect(localStorage.getItem(key)).toBe(null);
});
