// The phone's palette (rr-486.12): a full-screen search. A pill with back and clear around the input, chips that narrow
// the results by kind, Recent and Actions before typing, then the results grouped by kind; the list kept above the
// on-screen keyboard.
import { h, icon } from '../kernel/dom';
import { loadRaw, saveLocal } from '../kernel/store';
import { trackKeyboard } from '../kernel/keyboard';
import type { ReviewApp } from '../app';
import type { PaletteGroup, PaletteHost, PaletteItem, PaletteVariant } from './overlays';

type Item = PaletteItem;
type Recent = Pick<Item, 'kind' | 'label' | 'detail' | 'ref' | 'cmd'>;

/** The chips: what each narrows the results to (a kind), in the order results are grouped. */
const CHIPS = [
  ['all', 'All'],
  ['file', 'Files'],
  ['section', 'Sections'],
  ['symbol', 'Symbols'],
  ['thread', 'Threads'],
  ['command', 'Actions'],
] as const;
type Chip = (typeof CHIPS)[number][0];
const GROUP: Partial<Record<Item['kind'], string>> = { link: 'Link', file: 'Files', section: 'Sections', symbol: 'Symbols', text: 'Code', thread: 'Threads', command: 'Actions' };
const ORDER: Item['kind'][] = ['link', 'file', 'section', 'symbol', 'text', 'thread', 'command'];

export function phonePalette(app: ReviewApp, { input, close, refresh }: PaletteHost): PaletteVariant {
  const chips = h('div', { class: 'rr-palette__chips', role: 'group', 'aria-label': 'Show', hidden: true });
  let chip: Chip = 'all';
  const clear = h('button', { class: 'rr-icon-btn rr-palette__clear', 'aria-label': 'Clear', title: 'Clear', hidden: true, onclick: () => { input.value = ''; input.dispatchEvent(new Event('input')); input.focus(); } }, icon('close', 20));
  let stopKb: (() => void) | undefined; // the full-screen palette keeps its list above the keyboard

  const recentKey = () => `reviewroom:recent:${app.meta.id}`;
  // a list (loadLocal merges objects): anything else stored there is no list of recents
  const stored = (): Recent[] => {
    try {
      const v: unknown = JSON.parse(loadRaw(recentKey()) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const recents = (): Item[] =>
    stored().map((r) => ({ ...r, score: 0, run: () => (r.cmd ? app.commands.run(r.cmd) : r.ref && void app.open(r.ref)) }));

  return {
    top: [h('div', { class: 'rr-palette__bar' }, h('button', { class: 'rr-icon-btn', 'aria-label': 'Back', title: 'Back', onclick: () => close() }, icon('back', 24)), input, clear), chips],
    placeholder: 'Search this review',
    iconSize: 16,
    paint: (all, q, browsing) => {
      chips.hidden = !browsing;
      clear.hidden = !q;
      if (!browsing) return undefined;
      const typed = !!q.trim();
      const count = (c: Chip) => (c === 'all' ? all.length : all.filter((i) => i.kind === c).length);
      // the repo search's results (symbols, or code text still there from a / search)
      const searched = all.some((i) => i.kind === 'symbol' || i.kind === 'text');
      chips.replaceChildren(
        ...CHIPS.map(([c, label]) =>
          h('button', { class: 'rr-palette__chip' + (c === chip ? ' is-on' : ''), 'aria-pressed': String(c === chip), onclick: () => { chip = c; refresh(); } }, c === chip ? icon('check', 16) : null, label, c === 'symbol' && !searched ? null : h('span', null, String(count(c)))),
        ),
      );
      const shown = all.filter((i) => chip === 'all' || i.kind === chip);
      const groups: PaletteGroup[] = !typed && chip === 'all'
        ? [['Recent', recents(), 'history'], ['Actions', shown.filter((i) => i.kind === 'command')]]
        : ORDER.map((k): PaletteGroup => [GROUP[k]!, shown.filter((i) => i.kind === k).slice(0, 40)]);
      return groups.filter(([, g]) => g.length);
    },
    ran: (it) => {
      if (!it.ref && !it.cmd) return;
      const r: Recent = { kind: it.kind, label: it.label, detail: it.detail, ref: it.ref, cmd: it.cmd };
      saveLocal(recentKey(), [r, ...stored().filter((x) => x.ref !== r.ref || x.cmd !== r.cmd)].slice(0, 6));
    },
    opened: () => {
      chip = 'all';
      stopKb ??= trackKeyboard();
    },
    closed: () => {
      stopKb?.();
      stopKb = undefined;
    },
  };
}
