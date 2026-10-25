import { expect, test } from 'bun:test';
import { createActor, type ActorRefFrom } from 'xstate';
import { codeSheetMachine } from './codesheet.machine';
import { front, shellMachine, type ShellEvent } from './shell.machine';

function shell() {
  const a = createActor(shellMachine).start();
  const send = (...es: ShellEvent[]) => es.forEach((e) => a.send(e));
  send(
    { type: 'pages', area: 'read', ids: ['narrative', 'description'] },
    { type: 'pages', area: 'code', ids: ['code'] },
    { type: 'pages', area: 'threads', ids: ['threads', 'threads:resolved'] },
    { type: 'pages', area: 'files', ids: ['files', 'toc'] },
  );
  const c = () => a.getSnapshot().context;
  const code = () => a.getSnapshot().children.code as ActorRefFrom<typeof codeSheetMachine>;
  /** what Back would undo, newest last */
  const stack = () => c().stack.map((e) => (e.kind === 'area' ? `area:${e.prev}` : e.kind === 'sheet' ? `sheet:${e.id}` : e.kind));
  /** Back: the newest entry */
  const back = () => send({ type: 'back', key: c().stack.at(-1)!.key });
  return { a, send, c, code, stack, back };
}

test('Back closes the newest layer, then returns to earlier areas', () => {
  const s = shell();
  s.send({ type: 'show', id: 'narrative' });
  expect(s.stack()).toEqual([]);
  s.send({ type: 'nav', area: 'threads' }, { type: 'nav', area: 'files' });
  s.send({ type: 'show', id: 'thread:t1' }, { type: 'dialog', id: 1, open: true });
  expect(s.stack()).toEqual(['area:read', 'area:threads', 'sheet:thread:t1', 'dialog']);
  expect(front(s.c())).toBe('thread:t1');
  s.back(); // the dialog's entry (the view dismisses it)
  s.back();
  expect(s.c().sheets).toEqual([]);
  expect(front(s.c())).toBe('files');
  s.back();
  expect(s.c().area).toBe('threads');
  s.back();
  expect(s.c().area).toBe('read');
  expect(s.stack()).toEqual([]);
});

test('an area left for the one before it is the same as Back', () => {
  const s = shell();
  s.send({ type: 'nav', area: 'code' }, { type: 'nav', area: 'threads' });
  expect(s.stack()).toEqual(['area:read', 'area:code']);
  s.send({ type: 'nav', area: 'code' });
  expect(s.stack()).toEqual(['area:read']);
  s.send({ type: 'nav', area: 'code' }); // already there: nothing
  expect(s.stack()).toEqual(['area:read']);
});

test('a page shows its area (closing sheets) at that tab; a sheet shown again comes to the front without a new entry', () => {
  const s = shell();
  s.send({ type: 'show', id: 'thread:a' }, { type: 'show', id: 'thread:b' }, { type: 'show', id: 'thread:a' });
  expect(s.c().sheets).toEqual(['thread:b', 'thread:a']);
  expect(s.stack()).toEqual(['sheet:thread:a', 'sheet:thread:b']);
  s.send({ type: 'show', id: 'toc' });
  expect(s.c()).toMatchObject({ area: 'files', sheets: [], page: { files: 'toc' } });
  expect(s.stack()).toEqual(['area:read']);
  s.send({ type: 'pages', area: 'files', ids: ['files'] }); // Contents went away
  expect(s.c().page.files).toBe('files');
});

test('a code link outside the Code area peeks; Esc closes the peek before sheets', () => {
  const s = shell();
  s.send({ type: 'show', id: 'thread:a' }, { type: 'reveal', lines: true }, { type: 'show', id: 'code' });
  expect(s.code().getSnapshot().value).toEqual({ open: 'peek' });
  expect(s.stack()).toEqual(['sheet:thread:a', 'peek']);
  expect(front(s.c())).toBe('code');
  s.send({ type: 'escape' });
  expect(s.code().getSnapshot().value).toBe('closed');
  expect(s.stack()).toEqual(['sheet:thread:a']);
  s.send({ type: 'escape' });
  expect(s.stack()).toEqual([]);
  // inside the Code area a link doesn't peek
  s.send({ type: 'nav', area: 'code' }, { type: 'reveal', lines: true }, { type: 'show', id: 'code' });
  expect(s.code().getSnapshot().value).toBe('closed');
});

test('the peek dragged up past 70% becomes the Code area; Back returns', () => {
  const s = shell();
  s.send({ type: 'reveal', lines: true }, { type: 'show', id: 'code' });
  s.code().send({ type: 'start', from: 400, max: 1000 });
  s.code().send({ type: 'move', dy: -350 });
  expect(s.code().getSnapshot().context.height).toBe(750);
  s.code().send({ type: 'end', dy: -350 });
  expect(s.code().getSnapshot().value).toBe('full');
  expect(s.c().area).toBe('code');
  expect(s.stack()).toEqual(['area:read']);
  s.back();
  expect(s.c().area).toBe('read');
  // a link peeks again
  s.send({ type: 'reveal', lines: true }, { type: 'show', id: 'code' });
  expect(s.code().getSnapshot().value).toEqual({ open: 'peek' });
});

test('code sheet thresholds: below 25% closes, between stays a peek', () => {
  const sheet = createActor(codeSheetMachine).start();
  const drag = (dy: number) => (sheet.send({ type: 'open' }), sheet.send({ type: 'start', from: 400, max: 1000 }), sheet.send({ type: 'end', dy }), sheet.getSnapshot().value);
  expect(drag(200)).toBe('closed'); // 20%
  expect(drag(100)).toEqual({ open: 'peek' }); // 30%
  expect(drag(-299)).toEqual({ open: 'peek' }); // 69.9%
  sheet.send({ type: 'close' });
  expect(drag(-301)).toBe('full');
});
