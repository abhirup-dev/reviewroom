import { afterEach, expect, test } from 'bun:test';
import { mountReview } from './mount-review';

let fixture: Awaited<ReturnType<typeof mountReview>> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

test('author ref chips navigate once after reconnect, with readable labels and explicit file views', async () => {
  const f = fixture = await mountReview('<section id="overview"><h2>Overview</h2></section><rr-ref ref="rr:doc/overview"></rr-ref><rr-ref ref="rr:code/src/change.ts#L2-4">Changed lines</rr-ref><rr-ref ref="rr:file/README.md@base#L1"></rr-ref>');
  const code: unknown[] = [];
  const docs: unknown[] = [];
  f.app.bus.on('reveal-code', (target) => code.push(target));
  f.app.bus.on('reveal-doc', (target) => docs.push(target));
  const chips = [...f.doc.querySelectorAll<HTMLElement>('rr-ref')];
  expect(chips[0].textContent).toBe('Overview');
  expect(chips[1].textContent).toBe('Changed lines');
  expect(chips[2].textContent).not.toContain('rr:');
  expect(chips[0].getAttribute('role')).toBe('link');
  chips[0].click();
  chips[1].remove();
  f.doc.append(chips[1]);
  chips[1].dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  chips[2].click();
  expect(docs).toEqual([{ id: 'overview', path: undefined }]);
  expect(code).toEqual([
    { path: 'src/change.ts', side: 'head', start: 2, end: 4, rev: undefined, view: 'diff' },
    { path: 'README.md', side: 'base', start: 1, end: 1, rev: undefined, view: 'file' },
  ]);
  expect(f.storage.writes).toHaveLength(0);
});

test('check state survives detach, updates while absent, and a fresh app loading persisted state', async () => {
  const html = '<rr-check id="compat" state="pass"><strong>Compatibility</strong></rr-check>';
  const f = fixture = await mountReview(html);
  const check = f.doc.querySelector<HTMLElement>('rr-check')!;
  const changes: unknown[] = [];
  f.app.bus.on('state', (state) => changes.push(state));
  expect(check.dataset.state).toBe('pass');
  check.querySelector('button')!.click();
  expect(check.dataset.state).toBe('fail');
  check.remove();
  f.app.apply({ op: 'setCheck', id: 'compat', value: 'todo' });
  expect(check.dataset.state).toBe('fail');
  f.doc.append(check);
  expect(check.dataset.state).toBe('todo');
  check.querySelector('button')!.click();
  expect(check.dataset.state).toBe('pass');
  expect(check.querySelectorAll('button')).toHaveLength(1);
  expect(check.querySelector('strong')!.textContent).toBe('Compatibility');
  expect(changes).toHaveLength(3);
  expect(f.storage.writes.map(({ op }) => op)).toEqual([
    { op: 'setCheck', id: 'compat', value: 'fail' },
    { op: 'setCheck', id: 'compat', value: 'todo' },
    { op: 'setCheck', id: 'compat', value: 'pass' },
  ]);
  expect(f.storage.persisted()).toEqual(f.app.state);
  const storage = f.storage;
  f.dispose();
  fixture = undefined;
  const remount = fixture = await mountReview(html.replace('state="pass"', 'state="todo"'), storage);
  expect(remount.doc.querySelector<HTMLElement>('rr-check')!.dataset.state).toBe('pass');
  expect(storage.writes).toHaveLength(3);
});

test('walkthrough thread decorations leave authored nodes, content, and handlers intact', async () => {
  const f = fixture = await mountReview('<section id="overview"><h2>Overview</h2><p>Keep <em>this prose</em> intact.</p><details open><summary>Details</summary><button id="authored">Author action</button><svg><circle r="2"></circle></svg></details></section>');
  const authored = f.doc.innerHTML;
  const section = f.doc.firstElementChild;
  const button = f.doc.querySelector<HTMLButtonElement>('#authored')!;
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  const panel = f.mountWalkthroughPanel();
  await Promise.resolve();
  let notifications = 0;
  f.app.bus.on('state', () => notifications++);
  const thread = f.app.createThread({ kind: 'doc', target: 'overview' }, 'Explain this');
  if (!thread || thread instanceof Promise) throw new Error('Expected a local thread');
  expect(panel.element.querySelectorAll('.rr-rail-chip')).toHaveLength(1);
  const opened: string[] = [];
  f.app.bus.on('open-thread', ({ id }) => opened.push(id));
  panel.element.querySelector<HTMLButtonElement>('.rr-rail-chip')!.click();
  expect(opened).toEqual([thread.id]);
  void f.app.setStatus(thread.id, 'resolved');
  expect(panel.element.querySelector('.rr-rail-chip')!.classList.contains('is-resolved')).toBe(true);
  expect(notifications).toBe(2);
  expect(f.storage.writes).toHaveLength(2);
  expect(f.storage.persisted()).toEqual(f.app.state);
  expect(f.doc.firstElementChild).toBe(section);
  expect(f.doc.innerHTML).toBe(authored);
  button.click();
  expect(clicks).toBe(1);
});

test('dispose removes app listeners once and rejects invalid operations without persistence or state notifications', async () => {
  const f = fixture = await mountReview('<p>Review</p>');
  const original = f.app.state;
  let notifications = 0;
  const errors: unknown[] = [];
  f.app.bus.on('state', () => notifications++);
  f.app.bus.on('toast', (error) => errors.push(error));
  void f.app.reply('missing-thread', 'Cannot save');
  expect(f.app.state).toBe(original);
  expect(errors).toHaveLength(1);
  expect(notifications).toBe(0);
  expect(f.storage.writes).toHaveLength(0);
  let events = 0;
  let cleanups = 0;
  f.app.listen(document, 'click', () => events++);
  f.app.onDispose(() => cleanups++);
  document.dispatchEvent(new f.window.MouseEvent('click'));
  f.app.dispose();
  f.app.dispose();
  document.dispatchEvent(new f.window.MouseEvent('click'));
  expect(events).toBe(1);
  expect(cleanups).toBe(1);
});
