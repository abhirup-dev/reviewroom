// The hub's page (`reviewroom hub`): every review running on this machine, refreshed every 2 s from the hub's
// own server (a review server refuses requests from other ports). Filter, sort, open, close.
import { backdropCloses, h, icon, relTime } from '../core/dom';
import type { HubSnapshot, SessionInfo } from '../shared/hub';

type Compat = Record<string, { installed: string | null; verifiedAgainst: string; status: string }>;
type SortKey = 'tool' | 'subject' | 'kind' | 'repository' | 'branch' | 'cwd' | 'pid' | 'origin' | 'commentCount' | 'reviewRound' | 'startedAt';

const TOOLS: Record<string, string> = { reviewroom: 'reviewroom', crit: 'Crit', plannotator: 'Plannotator' };
const prettyKind = (k: string) => k.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const base = (p: string | null) => p?.split('/').filter(Boolean).pop() ?? '';

/** What the review is about, in a few words. */
function subject(s: SessionInfo): string {
  if (s.tool === 'reviewroom' && s.label) return s.label;
  if (s.target && !/^https?:\/\//.test(s.target)) return base(s.target) || s.target;
  if (s.kind === 'code-review') return s.branch || s.repository || 'Code changes';
  return s.target || s.label || s.project || s.branch || s.repository || base(s.cwd) || s.id;
}

// ------------------------------------------------------------ theme: follows the system
const dark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  const t = dark.matches ? 'dark' : 'light';
  document.documentElement.dataset.rrTheme = t;
  document.documentElement.style.colorScheme = t;
};
applyTheme();
dark.addEventListener('change', applyTheme);

// ------------------------------------------------------------ state
let data: HubSnapshot | null = null;
let failed = '';
let warnings: string[] = [];
const selected = new Set<string>();
const sort: { key: SortKey; dir: 1 | -1 } = { key: 'startedAt', dir: -1 };
let painted = '';

// ------------------------------------------------------------ elements
const input = (attrs: Record<string, unknown>) => h('input', { class: 'rr-input', oninput: () => paint(), ...attrs });
const select = (label: string) => h('select', { class: 'rr-select', 'aria-label': label, title: label, onchange: () => paint() });
const f = {
  q: input({ type: 'search', placeholder: 'Filter by title, repository, branch, pid…', 'aria-label': 'Filter', class: 'rr-input rr-hub__search' }),
  tool: select('Tool'),
  kind: select('Kind'),
  repo: select('Repository'),
  branch: select('Branch'),
  cwd: select('Working directory'),
  comments: input({ type: 'number', min: '0', placeholder: 'Min comments', 'aria-label': 'Minimum comments', title: 'Minimum comments', class: 'rr-input rr-hub__num' }),
  round: input({ type: 'number', min: '1', placeholder: 'Min round', 'aria-label': 'Minimum round', title: 'Minimum round', class: 'rr-input rr-hub__num' }),
};
const selectOptions: [HTMLSelectElement, string, (s: SessionInfo) => string | null][] = [
  [f.tool, 'All tools', (s) => s.tool],
  [f.kind, 'All kinds', (s) => s.kind],
  [f.repo, 'All repositories', (s) => s.repository],
  [f.branch, 'All branches', (s) => s.branch],
  [f.cwd, 'All directories', (s) => s.cwd],
];

const meta = h('div', { class: 'rr-header__meta' });
const banners = h('div', { class: 'rr-hub__banners' });
const count = h('span', { class: 'rr-hub__count' });
const openBtn = h('button', { class: 'rr-btn rr-btn--small', title: 'Open the selected sessions in new tabs', onclick: () => chosen().forEach(open) }, icon('popout', 14), 'Open');
const closeBtn = h('button', { class: 'rr-btn rr-btn--small', title: 'Stop the selected sessions', onclick: () => askClose(chosen()) }, icon('close', 14), 'Close…');
const all = h('input', { type: 'checkbox', class: 'rr-hub__check', 'aria-label': 'Select all shown', onchange: () => (visible().forEach((s) => (all.checked ? selected.add(s.id) : selected.delete(s.id))), paint()) });
const body = h('tbody');
const empty = h('div', { class: 'rr-empty rr-hub__empty' });

const columns: [SortKey | null, string, string?][] = [
  // where the review stands first; where it runs (repository, directory, processes) after, scrolled to on narrow screens
  ['tool', 'Tool'],
  ['subject', 'Review'],
  ['reviewRound', 'Round', 'num'],
  ['commentCount', 'Comments', 'num'],
  [null, 'Health'],
  ['startedAt', 'Started'],
  ['kind', 'Kind'],
  ['repository', 'Repository'],
  ['branch', 'Branch'],
  ['cwd', 'Directory'],
  ['origin', 'Agent'],
  ['pid', 'PID'],
  [null, ''],
];
const heads = columns.map(([key, label, cls]) =>
  h('th', { class: cls, onclick: key ? () => ((sort.dir = sort.key === key ? (-sort.dir as 1 | -1) : 1), (sort.key = key), paint()) : undefined, 'data-sort': key ?? undefined }, label),
);
const table = h('table', { class: 'rr-hub__table' }, h('thead', null, h('tr', null, h('th', { class: 'rr-hub__sel' }, all), ...heads)), body);

document.body.append(
  h(
    'div',
    { class: 'rr-root rr-hub' },
    h(
      'header',
      { class: 'rr-header' },
      h('div', { class: 'rr-header__id' }, h('div', { class: 'rr-mark', 'aria-hidden': 'true' }, 'rr'), h('div', { class: 'rr-header__titles' }, h('div', { class: 'rr-header__title' }, 'All reviews'), meta)),
    ),
    banners,
    h(
      'div',
      { class: 'rr-hub__bar' },
      f.q, f.tool, f.kind, f.repo, f.branch, f.cwd, f.comments, f.round,
      h('button', { class: 'rr-btn rr-btn--ghost rr-btn--small', title: 'Clear every filter', onclick: () => (Object.values(f).forEach((el) => (el.value = '')), paint()) }, 'Clear'),
      h('span', { class: 'rr-hub__spacer' }),
      count, openBtn, closeBtn,
    ),
    h('div', { class: 'rr-hub__scroll' }, table, empty),
  ),
);

// ------------------------------------------------------------ filtering and sorting
function visible(): SessionInfo[] {
  const q = f.q.value.trim().toLowerCase();
  const text = (s: SessionInfo) => [s.id, s.tool, s.category, s.kind, s.target, s.repository, s.repoRoot, s.branch, s.cwd, s.pid, s.parentAgentPid, s.origin, s.mode, s.label, s.project].join(' ').toLowerCase();
  const rows = (data?.sessions ?? []).filter(
    (s) =>
      (!q || text(s).includes(q)) &&
      (!f.tool.value || s.tool === f.tool.value) &&
      (!f.kind.value || s.kind === f.kind.value) &&
      (!f.repo.value || s.repository === f.repo.value) &&
      (!f.branch.value || s.branch === f.branch.value) &&
      (!f.cwd.value || s.cwd === f.cwd.value) &&
      (!f.comments.value || (s.commentCount ?? -1) >= +f.comments.value) &&
      (!f.round.value || (s.reviewRound ?? -1) >= +f.round.value),
  );
  const val = (s: SessionInfo) => (sort.key === 'subject' ? subject(s) : sort.key === 'startedAt' ? Date.parse(s.startedAt ?? '') || null : s[sort.key]);
  return rows.sort((a, b) => {
    const [x, y] = [val(a), val(b)];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // unknowns last
    return sort.dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));
  });
}
const chosen = () => visible().filter((s) => selected.has(s.id));
const open = (s: SessionInfo) => s.url && window.open(s.url, '_blank', 'noopener');

// ------------------------------------------------------------ rendering
function row(s: SessionInfo) {
  const on = selected.has(s.id);
  const agent = s.origin ? h('span', { title: `${s.originSource ?? ''} (pid ${s.parentAgentPid})` }, s.origin, h('span', { class: 'rr-hub__dim' }, ` ${s.parentAgentPid}`)) : '–';
  const comments = s.commentCount == null ? '–' : s.unresolvedCommentCount != null ? h('span', { title: `${s.unresolvedCommentCount} open of ${s.commentCount}` }, String(s.commentCount)) : String(s.commentCount);
  return h(
    'tr',
    { class: on ? 'is-selected' : undefined, ondblclick: (e: MouseEvent) => !(e.target as Element).closest('a, button, input') && open(s) },
    h('td', { class: 'rr-hub__sel' }, h('input', { type: 'checkbox', class: 'rr-hub__check', checked: on, 'aria-label': `Select ${subject(s)}`, onchange: () => (on ? selected.delete(s.id) : selected.add(s.id), paint()) })),
    h('td', null, TOOLS[s.tool] ?? s.tool),
    h('td', { class: 'rr-hub__subject', title: s.target ?? subject(s) }, subject(s)),
    h('td', { class: 'num' }, String(s.reviewRound ?? '–')),
    h('td', { class: 'num' }, comments),
    h('td', null, h('span', { class: `rr-pill rr-hub__health rr-hub__health--${s.health}`, title: s.health === 'unreachable' ? 'Did not answer in time' : s.urlNote ?? '' }, s.health)),
    h('td', { title: s.startedAt ?? '' }, s.startedAt ? relTime(s.startedAt) : '–'),
    h('td', { title: s.category }, prettyKind(s.kind)),
    h('td', { class: 'rr-hub__trunc', title: s.repoRoot ?? '' }, s.repository ?? '–'),
    h('td', { class: 'rr-hub__mono rr-hub__trunc', title: s.branch ?? '' }, s.branch ?? '–', s.worktree ? h('span', { class: 'rr-hub__dim', title: 'A linked git worktree' }, ' wt') : null),
    h('td', { class: 'rr-hub__mono rr-hub__trunc rr-hub__cwd', title: s.cwd ?? '' }, s.cwd ?? '–'),
    h('td', null, agent),
    h('td', { class: 'rr-hub__mono' }, String(s.pid ?? '–')),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'rr-hub__actions' },
          s.url ? h('a', { class: 'rr-icon-btn', href: s.url, target: '_blank', rel: 'noopener', title: 'Open', 'aria-label': `Open ${subject(s)}` }, icon('popout', 14)) : h('span', { class: 'rr-icon-btn', title: s.urlNote ?? 'No safe URL' }, '–'),
        h('button', { class: 'rr-icon-btn', title: 'Close session…', 'aria-label': `Close ${subject(s)}`, onclick: () => askClose([s]) }, icon('close', 14)),
      ),
    ),
  );
}

function paint() {
  const ids = new Set((data?.sessions ?? []).map((s) => s.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  const rows = visible();
  const total = data?.sessions.length ?? 0;
  const picked = rows.filter((s) => selected.has(s.id));
  // re-render only on change: a 2 s refresh must not steal focus or a hover
  const key = JSON.stringify([rows.map((s) => [{ ...s, lastSeenAt: '', updatedAt: '' }, s.startedAt && relTime(s.startedAt)]), [...selected], sort, failed, warnings, data?.generatedAt && relTime(data.generatedAt)]);
  if (key === painted) return;
  painted = key;
  meta.replaceChildren(h('span', { class: 'rr-pill' }, `${total} running`));
  if (rows.length !== total) meta.append(h('span', { class: 'rr-pill' }, `${rows.length} shown`));
  if (data) meta.append(h('span', { class: 'rr-pill', title: data.generatedAt }, `updated ${relTime(data.generatedAt)}`));
  banners.replaceChildren(
    ...(failed ? [h('div', { class: 'rr-hub__banner rr-hub__banner--risk', role: 'alert' }, failed)] : []),
    ...warnings.map((w) => h('div', { class: 'rr-hub__banner' }, w)),
  );
  count.textContent = picked.length ? `${picked.length} selected` : '';
  openBtn.disabled = !picked.some((s) => s.url);
  closeBtn.disabled = !picked.length;
  all.checked = !!rows.length && picked.length === rows.length;
  all.indeterminate = picked.length > 0 && picked.length < rows.length;
  heads.forEach((th) => (th.dataset.sort === sort.key ? th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort')));
  body.replaceChildren(...rows.map(row));
  table.hidden = !rows.length;
  empty.hidden = !!rows.length;
  empty.textContent = total ? 'No sessions match the filters.' : 'No reviews running. Start one with `reviewroom pr`; Crit and Plannotator sessions show up here too.';
}

function fillSelects() {
  for (const [el, label, get] of selectOptions) {
    const values = [...new Set((data?.sessions ?? []).map(get).filter((v): v is string => !!v))].sort();
    const old = el.value;
    el.replaceChildren(h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v }, el === f.kind ? prettyKind(v) : el === f.tool ? (TOOLS[v] ?? v) : v)));
    el.value = values.includes(old) ? old : '';
  }
}

// ------------------------------------------------------------ closing
function askClose(items: SessionInfo[]) {
  if (!items.length) return;
  const close = () => box.close();
  const confirm = h('button', { class: 'rr-btn rr-btn--primary', onclick: () => void go() }, items.length === 1 ? 'Close session' : `Close ${items.length} sessions`);
  const go = async () => {
    confirm.disabled = true;
    for (const s of items) {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/close`, { method: 'POST', headers: { 'x-reviewroom-action': 'close-session' } }).catch(() => null);
      if (r?.ok) selected.delete(s.id);
    }
    close();
    setTimeout(refresh, 250);
  };
  const text = items.length === 1 ? `Stop “${subject(items[0])}” (${TOOLS[items[0].tool]}, pid ${items[0].pid})?` : `Stop ${items.length} sessions?`;
  const box = h(
    'dialog',
    { class: 'rr-modal rr-modal--narrow', 'aria-label': 'Close sessions', onmousedown: backdropCloses, onclose: () => box.remove() },
    h('header', { class: 'rr-thread__head' }, h('strong', null, items.length === 1 ? 'Close session?' : 'Close sessions?'), h('span', { class: 'rr-hub__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Cancel', onclick: close }, icon('close', 14))),
    h('div', { class: 'rr-send__body' }, h('p', { class: 'rr-hub__p' }, text), h('p', { class: 'rr-hub__p rr-hub__dim' }, 'Its server stops; a tab still open on it disconnects. A reviewroom review keeps its threads and rounds.')),
    h('footer', { class: 'rr-composer__foot rr-hub__foot' }, h('button', { class: 'rr-btn', onclick: close }, 'Cancel'), confirm),
  );
  document.body.append(box);
  box.showModal();
  confirm.focus();
}

// ------------------------------------------------------------ polling
async function refresh() {
  try {
    const [r, hr] = await Promise.all([fetch('/api/sessions', { cache: 'no-store' }), fetch('/api/health', { cache: 'no-store' })]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = (await r.json()) as HubSnapshot;
    const health = hr.ok ? ((await hr.json()) as { compatibility?: Compat }) : null;
    const compat = Object.entries(health?.compatibility ?? {})
      .filter(([tool, c]) => c.status === 'unverified' || (c.status === 'unavailable' && data!.sessions.some((s) => s.tool === tool)))
      .map(([tool, c]) => `${TOOLS[tool]} ${c.installed ?? '(version unknown)'} is not the version the hub was checked against (${c.verifiedAgainst}); its sessions may show less.`);
    warnings = [data.lastError, ...compat].filter((w): w is string => !!w);
    failed = '';
    fillSelects();
  } catch (e) {
    failed = `The hub is not answering (${(e as Error).message}). Start it again with \`reviewroom hub\`.`;
  }
  paint();
}

setInterval(refresh, 2000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
void refresh();
