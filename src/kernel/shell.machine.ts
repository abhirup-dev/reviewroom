// The phone shell's navigation, render-agnostic (the view, src/kernel/phone.ts, mounts panels and keeps history):
//
//   area      one of four (Read, Code, Threads, Files), each with its pages and the one its pager shows
//   sheets    on-demand panels (a thread, a code pop-out) over the area, the front one last
//   code      the code sheet (codesheet.machine.ts), invoked: a code link outside the Code area peeks
//   stack     what Back undoes, oldest first: each layer opened (a dialog such as the menu or search, the peek, a
//             sheet) and each area left. The view gives every entry a browser history entry; Back pops the newest
//             (`back`), and an entry closed some other way leaves the stack (the view takes its history entry out).
//
// In front: the peek, else the newest sheet, else the area's page (dialogs aside). Esc closes the same way.
import { assign, enqueueActions, sendParent, sendTo, setup } from 'xstate';
import { codeSheetMachine } from './codesheet.machine';

export type AreaId = 'read' | 'code' | 'threads' | 'files';
type NewEntry = { kind: 'area'; prev: AreaId } | { kind: 'sheet'; id: string } | { kind: 'peek' } | { kind: 'dialog'; id: number };
export type ShellEntry = NewEntry & { key: number };
export type ShellContext = {
  area: AreaId;
  pages: Record<AreaId, string[]>;
  page: Record<AreaId, string>;
  sheets: string[];
  stack: ShellEntry[];
  next: number;
  /** the latest code link shows lines outside the Code area: the code panel's next show peeks */
  peekNext: boolean;
  /** the panel in front when the selection was made: Comment shows only while that panel is */
  selectedIn: string;
};

export type ShellEvent =
  /** an area's pages, again (some come and go) */
  | { type: 'pages'; area: AreaId; ids: string[] }
  /** the pager settled on a page */
  | { type: 'page'; area: AreaId; id: string }
  /** bring a panel to the front: a page (its area), else a sheet; the view mounted it */
  | { type: 'show'; id: string }
  | { type: 'close'; id: string }
  /** a tap on an area in the bottom bar */
  | { type: 'nav'; area: AreaId }
  /** a link to code: `lines` when it shows some lines in the whole Code view (a peek, outside the Code area) */
  | { type: 'reveal'; lines: boolean }
  | { type: 'selection'; on: boolean }
  | { type: 'dialog'; id: number; open: boolean }
  /** Back popped this entry's history entry */
  | { type: 'back'; key: number }
  /** Esc: the peek, else the newest sheet */
  | { type: 'escape' }
  | { type: 'code.opened' }
  | { type: 'code.shut' }
  | { type: 'code.full' };

const AREAS: AreaId[] = ['read', 'code', 'threads', 'files'];
const each = <T>(f: (a: AreaId) => T) => Object.fromEntries(AREAS.map((a) => [a, f(a)])) as Record<AreaId, T>;

export const areaOf = (c: ShellContext, id: string) => AREAS.find((a) => c.pages[a].includes(id));
export const peeking = (c: ShellContext) => c.stack.some((e) => e.kind === 'peek');
/** The panel in front: the peeked code, the newest sheet, else the area's page. */
export const front = (c: ShellContext) => (peeking(c) ? 'code' : (c.sheets.at(-1) ?? c.page[c.area]));

type Patch = Partial<ShellContext>;
const push = (c: ShellContext, e: NewEntry): Patch => ({ stack: [...c.stack, { ...e, key: c.next }], next: c.next + 1 });
const without = (c: ShellContext, sheets: string[]): Patch => ({ sheets: c.sheets.filter((s) => !sheets.includes(s)), stack: c.stack.filter((e) => !(e.kind === 'sheet' && sheets.includes(e.id))) });
/** To area `id`; `back`: Back brought it here (its entry is gone already, no new one). */
function toArea(c: ShellContext, id: AreaId, back = false): Patch {
  if (id === c.area || back) return { area: id };
  const top = c.stack.findLast((e) => e.kind === 'area');
  // back where Back would go: the same as going back
  if (top?.kind === 'area' && top.prev === id) return { area: id, stack: c.stack.filter((e) => e !== top) };
  return { area: id, ...push(c, { kind: 'area', prev: c.area }) };
}
const merge = (c: ShellContext, ...patches: ((c: ShellContext) => Patch)[]) => patches.reduce((acc, p) => ({ ...acc, ...p(acc) }), c);

export const shellMachine = setup({
  types: { context: {} as ShellContext, events: {} as ShellEvent },
  actors: {
    code: codeSheetMachine.provide({
      actions: { opened: sendParent({ type: 'code.opened' }), shut: sendParent({ type: 'code.shut' }), full: sendParent({ type: 'code.full' }) },
    }),
  },
}).createMachine({
  id: 'shell',
  context: { area: 'read', pages: each(() => []), page: each(() => ''), sheets: [], stack: [], next: 1, peekNext: false, selectedIn: '' },
  invoke: { id: 'code', src: 'code' },
  on: {
    pages: { actions: assign(({ context: c, event: e }) => ({ pages: { ...c.pages, [e.area]: e.ids }, page: { ...c.page, [e.area]: e.ids.includes(c.page[e.area]) ? c.page[e.area] : (e.ids[0] ?? '') } })) },
    page: { actions: assign(({ context: c, event: e }) => ({ page: { ...c.page, [e.area]: e.id } })) },
    reveal: { actions: assign(({ context: c, event: e }) => ({ peekNext: e.lines && c.area !== 'code' })) },
    selection: { actions: assign(({ context: c, event: e }) => ({ selectedIn: e.on ? front(c) : '' })) },
    dialog: { actions: assign(({ context: c, event: e }) => (e.open ? push(c, { kind: 'dialog', id: e.id }) : { stack: c.stack.filter((x) => !(x.kind === 'dialog' && x.id === e.id)) })) },
    close: { actions: assign(({ context: c, event: e }) => without(c, [e.id])) },
    'code.opened': { actions: assign(({ context: c }) => (peeking(c) ? {} : push(c, { kind: 'peek' }))) },
    'code.shut': { actions: assign(({ context: c }) => ({ stack: c.stack.filter((e) => e.kind !== 'peek') })) },
    // the peek became the Code area
    'code.full': { actions: assign(({ context: c }) => toArea(c, 'code')) },
    // into an area (the same view, now full) or away from it, the peek goes; a page or the bar closes the sheets too
    nav: { actions: [sendTo('code', { type: 'close' }), assign(({ context: c, event: e }) => merge(c, (x) => without(x, x.sheets), (x) => toArea(x, e.area)))] },
    show: {
      actions: enqueueActions(({ context: c, event: e, enqueue }) => {
        const area = areaOf(c, e.id);
        if (area === 'code' && c.peekNext) {
          enqueue.assign({ peekNext: false });
          enqueue.sendTo('code', { type: 'open' });
        } else if (area) {
          enqueue.sendTo('code', { type: 'close' });
          enqueue.assign(merge(c, (x) => without(x, x.sheets), (x) => toArea(x, area), (x) => ({ page: { ...x.page, [area]: e.id } })));
        } else {
          const has = c.stack.some((x) => x.kind === 'sheet' && x.id === e.id);
          enqueue.assign({ ...(has ? {} : push(c, { kind: 'sheet', id: e.id })), sheets: [...c.sheets.filter((s) => s !== e.id), e.id] });
        }
      }),
    },
    back: {
      actions: enqueueActions(({ context: c, event: e, enqueue }) => {
        const entry = c.stack.find((x) => x.key === e.key);
        if (!entry) return;
        const rest = { ...c, stack: c.stack.filter((x) => x !== entry) };
        if (entry.kind === 'peek') enqueue.sendTo('code', { type: 'close' });
        else if (entry.kind === 'sheet') enqueue.assign(without(rest, [entry.id]));
        else if (entry.kind === 'area') {
          enqueue.sendTo('code', { type: 'close' });
          enqueue.assign({ stack: rest.stack, ...toArea(rest, entry.prev, true) });
        } else enqueue.assign({ stack: rest.stack });
      }),
    },
    escape: {
      actions: enqueueActions(({ context: c, enqueue }) => {
        if (peeking(c)) enqueue.sendTo('code', { type: 'close' });
        else if (c.sheets.length) enqueue.assign(without(c, [c.sheets.at(-1)!]));
      }),
    },
  },
});
