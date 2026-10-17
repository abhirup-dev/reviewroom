// The hub's page (`reviewroom hub`): every review running on this machine, refreshed every 2 s from the hub's
// own server (a review server refuses requests from other ports). Filter, sort, open, close.
import { backdropCloses, h, icon, relTime } from '../core/dom';
import { mountTooltips } from '../overlays/tooltip';
import { CRIT_LOGO, PLANNOTATOR_LOGO } from './logos';
import type { HubSnapshot, SessionInfo } from '../shared/hub';
// the agents' own marks (LobeHub icons, MIT), bundled as text
import claudeCode from '@lobehub/icons-static-svg/icons/claudecode-color.svg' with { type: 'text' };
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg' with { type: 'text' };
import copilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg' with { type: 'text' };
import geminiCli from '@lobehub/icons-static-svg/icons/geminicli-color.svg' with { type: 'text' };
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg' with { type: 'text' };
import kiro from '@lobehub/icons-static-svg/icons/kiro-color.svg' with { type: 'text' };
import amp from '@lobehub/icons-static-svg/icons/amp-color.svg' with { type: 'text' };
import pi from '@lobehub/icons-static-svg/icons/pi.svg' with { type: 'text' };

type Compat = Record<string, { installed: string | null; verifiedAgainst: string; status: string }>;
type SortKey = 'tool' | 'subject' | 'author' | 'kind' | 'repository' | 'branch' | 'cwd' | 'pid' | 'origin' | 'commentCount' | 'reviewRound' | 'startedAt';

/** Agent names as cli/hub/proc.ts reports them -> display name and mark (droid has none: shown as text). */
const AGENTS: Record<string, [name: string, svg?: string]> = {
  'claude-code': ['Claude Code', claudeCode],
  codex: ['Codex', codex],
  'copilot-cli': ['GitHub Copilot', copilot],
  'gemini-cli': ['Gemini CLI', geminiCli],
  opencode: ['OpenCode', opencode],
  'kiro-cli': ['Kiro', kiro],
  amp: ['Amp', amp],
  pi: ['Pi', pi],
  'oh-my-pi': ['oh-my-pi', pi],
  droid: ['Droid'],
};
const TOOLS: Record<string, string> = { reviewroom: 'reviewroom', crit: 'Crit', plannotator: 'Plannotator' };
/** "5 min. ago" within a week, else the day without the year ("Oct 8"). */
const started = (iso: string) => (Date.now() - Date.parse(iso) < 7 * 86400e3 ? relTime(iso) : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
/** The tool's mark: reviewroom's own rr square, Crit's and Plannotator's favicons. */
const toolMark = (tool: string) =>
  h(
    'span',
    { class: 'rr-hub__tool', title: TOOLS[tool] ?? tool, 'aria-label': TOOLS[tool] ?? tool },
    tool === 'reviewroom' ? h('span', { class: 'rr-mark' }, 'rr') : h('img', { src: tool === 'crit' ? CRIT_LOGO : PLANNOTATOR_LOGO, alt: '' }),
  );
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
const seen = new Set<string>(); // sessions already shown: only new ones fade in

// ------------------------------------------------------------ elements
const input = (attrs: Record<string, unknown>) => h('input', { class: 'rr-input', oninput: () => paint(), ...attrs });
const select = (label: string, tip: string) => h('select', { class: 'rr-select', 'aria-label': label, title: tip, onchange: () => paint() });
const f = {
  q: input({ type: 'search', placeholder: 'Filter by title, repository, branch, pid…', 'aria-label': 'Filter', title: 'Show only rows containing this text: title, repository, branch, directory, pid or agent', class: 'rr-input rr-hub__search' }),
  tool: select('Tool', 'Show only one tool’s sessions'),
  kind: select('Kind', 'Show only one kind of review'),
  repo: select('Repository', 'Show only reviews of one repository'),
  branch: select('Branch', 'Show only sessions on one branch'),
  cwd: select('Working directory', 'Show only sessions started in one directory'),
  author: select('Author', 'Show only reviews of one author’s pull requests, or the ones with no PR author'),
  comments: input({ type: 'number', min: '0', placeholder: 'Min comments', 'aria-label': 'Minimum comments', title: 'Show only sessions with at least this many comments', class: 'rr-input rr-hub__num' }),
  round: input({ type: 'number', min: '1', placeholder: 'Min round', 'aria-label': 'Minimum round', title: 'Show only sessions on this round or later', class: 'rr-input rr-hub__num' }),
};
/** The Author filter's value for sessions without a PR author (self-reviews, Crit, Plannotator). */
const NO_AUTHOR = '\u0000none';
const selectOptions: [HTMLSelectElement, string, (s: SessionInfo) => string | null][] = [
  [f.tool, 'All tools', (s) => s.tool],
  [f.kind, 'All kinds', (s) => s.kind],
  [f.repo, 'All repositories', (s) => s.repository],
  [f.branch, 'All branches', (s) => s.branch],
  [f.cwd, 'All directories', (s) => s.cwd],
  [f.author, 'All authors', (s) => s.author ?? NO_AUTHOR],
];

const meta = h('div', { class: 'rr-header__meta' });
const banners = h('div', { class: 'rr-hub__banners' });
const count = h('span', { class: 'rr-hub__count' });
const openBtn = h('button', { class: 'rr-btn rr-btn--small', disabled: true, title: 'Open the selected sessions in new tabs', onclick: () => chosen().forEach(open) }, icon('popout', 14), 'Open');
const closeBtn = h('button', { class: 'rr-btn rr-btn--small', disabled: true, title: 'Stop the selected sessions (asks first)', onclick: () => askClose(chosen()) }, icon('close', 14), 'Close…');
const all = h('input', { type: 'checkbox', class: 'rr-hub__check', 'aria-label': 'Select all shown', title: 'Select every session shown', onchange: () => (visible().forEach((s) => (all.checked ? selected.add(s.id) : selected.delete(s.id))), paint()) });
const body = h('tbody');
const empty = h('div', { class: 'rr-empty rr-hub__empty' }, 'Looking for running reviews…');

const columns: [SortKey | null, string, string, string?][] = [
  // where the review stands first; where it runs (repository, directory, processes) after, scrolled to on narrow screens
  ['tool', 'Tool', 'The review tool running the session'],
  ['subject', 'Review', 'What is under review: the title, PR, branch or file'],
  ['author', 'Author', 'Who opened the pull request on GitHub (only for reviews of a PR)'],
  ['reviewRound', 'Round', 'The review round it is on: each round ends when the reviewer sends feedback', 'num'],
  ['commentCount', 'Comments', 'Comment threads so far (hover a number for how many are open)', 'num'],
  ['startedAt', 'Started', 'When the session’s server started'],
  ['kind', 'Kind', 'What kind of review, from how it was launched'],
  ['repository', 'Repository', 'The git repository it reviews'],
  ['branch', 'Branch', 'The checked-out branch; wt marks a linked worktree'],
  ['cwd', 'Directory', 'Where the session was started'],
  ['origin', 'Agent', 'The agent CLI that started it, and its pid'],
  ['pid', 'PID', 'Process id of the session’s server'],
  [null, '', ''],
];
/** A column's class (c-round, c-directory, ...): narrow screens hide the least needed ones (hub.css). */
const col = (label: string) => `c-${(label || 'actions').toLowerCase()}`;
const heads = columns.map(([key, label, tip, cls]) =>
  h('th', { class: [cls, col(label)].filter(Boolean).join(' '), title: tip ? (key ? `${tip}. Click to sort` : tip) : undefined, onclick: key ? () => ((sort.dir = sort.key === key ? (-sort.dir as 1 | -1) : 1), (sort.key = key), paint()) : undefined, 'data-sort': key ?? undefined }, label),
);
const table = h('table', { class: 'rr-hub__table', hidden: true }, h('thead', null, h('tr', null, h('th', { class: 'rr-hub__sel' }, all), ...heads)), body);

mountTooltips();
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
      f.q, f.tool, f.author, f.kind, f.repo, f.branch, f.cwd, f.comments, f.round,
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
  const text = (s: SessionInfo) => [s.id, s.tool, s.category, s.kind, s.target, s.repository, s.repoRoot, s.branch, s.cwd, s.pid, s.parentAgentPid, s.origin, s.author, s.mode, s.label, s.project].join(' ').toLowerCase();
  const rows = (data?.sessions ?? []).filter(
    (s) =>
      (!q || text(s).includes(q)) &&
      (!f.tool.value || s.tool === f.tool.value) &&
      (!f.kind.value || s.kind === f.kind.value) &&
      (!f.repo.value || s.repository === f.repo.value) &&
      (!f.branch.value || s.branch === f.branch.value) &&
      (!f.cwd.value || s.cwd === f.cwd.value) &&
      (!f.author.value || (s.author ?? NO_AUTHOR) === f.author.value) &&
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
const inApp = 'reviewroomApp' in window; // set by the macOS app (app/src/main.rs), which opens local pages in its tabs

// ------------------------------------------------------------ rendering
function row(s: SessionInfo) {
  const on = selected.has(s.id);
  const [agentName, mark] = s.origin ? (AGENTS[s.origin] ?? [s.origin]) : [];
  const agent = s.origin
    ? h('span', { class: 'rr-hub__agent', title: `${agentName}, pid ${s.parentAgentPid}: ${s.originSource ?? ''}` }, mark ? h('span', { class: 'rr-hub__mark', html: mark.replace(/<title>.*?<\/title>/, ''), 'aria-label': agentName }) : agentName)
    : h('span', { title: 'No agent CLI found among its parent processes' }, '–');
  const comments = s.commentCount == null ? h('span', { title: 'Not reported by this tool' }, '–') : s.unresolvedCommentCount != null ? h('span', { title: `${s.unresolvedCommentCount} open of ${s.commentCount}` }, String(s.commentCount)) : String(s.commentCount);
  return h(
    'tr',
    { class: [on && 'is-selected', !seen.has(s.id) && 'is-new'].filter(Boolean).join(' ') || undefined, ondblclick: (e: MouseEvent) => !(e.target as Element).closest('a, button, input') && open(s) },
    h('td', { class: 'rr-hub__sel' }, h('input', { type: 'checkbox', class: 'rr-hub__check', checked: on, 'aria-label': `Select ${subject(s)}`, title: 'Select for Open or Close', onchange: () => (on ? selected.delete(s.id) : selected.add(s.id), paint()) })),
    h('td', { class: col('Tool') }, toolMark(s.tool)),
    h(
      'td',
      { class: 'rr-hub__subject', title: s.target ?? subject(s) },
      h('div', { class: 'rr-hub__name' }, subject(s)),
      // what the hidden columns said, under the title on narrow screens
      h('div', { class: 'rr-hub__sub' }, h('span', { class: 'rr-hub__sub-tool' }, toolMark(s.tool)), h('span', { class: 'rr-hub__sub-text' }, [s.repository, s.branch, prettyKind(s.kind)].filter(Boolean).join(' · ')), s.origin ? agent.cloneNode(true) : null),
    ),
    h(
      'td',
      { class: 'c-author' },
      s.author
        ? h('span', { class: 'rr-hub__author', title: `@${s.author} opened this pull request` }, h('img', { class: 'rr-hub__avatar', src: `https://avatars.githubusercontent.com/${s.author}?s=40`, alt: '', loading: 'lazy' }), s.author)
        : null,
    ),
    h('td', { class: 'num c-round', title: s.reviewRound == null ? 'Not reported by this tool' : `Round ${s.reviewRound}` }, String(s.reviewRound ?? '–')),
    h('td', { class: 'num c-comments' }, comments),
    h('td', { class: 'c-started', title: s.startedAt ? new Date(s.startedAt).toLocaleString() : 'Not recorded' }, s.startedAt ? started(s.startedAt) : '–'),
    h('td', { class: 'c-kind', title: `${prettyKind(s.kind)} (${s.category}), from ${s.classificationSource}` }, prettyKind(s.kind)),
    h('td', { class: 'rr-hub__trunc c-repository', title: s.repoRoot ?? '' }, s.repository ?? '–'),
    h('td', { class: 'rr-hub__mono rr-hub__trunc c-branch', title: s.branch ?? '' }, s.branch ?? '–', s.worktree ? h('span', { class: 'rr-hub__dim', title: 'A linked git worktree' }, ' wt') : null),
    h('td', { class: 'rr-hub__mono rr-hub__trunc rr-hub__cwd c-directory', title: s.cwd ?? '' }, s.cwd ?? '–'),
    h('td', { class: 'c-agent' }, agent),
    h('td', { class: 'rr-hub__mono c-pid', title: `Server process ${s.pid ?? 'unknown'}${s.port ? ` on port ${s.port}` : ''}` }, String(s.pid ?? '–')),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'rr-hub__actions' },
          s.url ? h('a', { class: 'rr-icon-btn', href: s.url, target: '_blank', rel: 'noopener', title: inApp ? 'Open in a tab here' : 'Open in a new tab', 'aria-label': `Open ${subject(s)}` }, icon('popout', 14)) : h('span', { class: 'rr-icon-btn', title: `Cannot open: ${s.urlNote ?? 'no loopback URL'}` }, '–'),
        // #rr-browser: the app hands this one to the browser instead
        inApp && s.url ? h('a', { class: 'rr-icon-btn', href: `${s.url}#rr-browser`, target: '_blank', rel: 'noopener', title: 'Open in the browser', 'aria-label': `Open ${subject(s)} in the browser` }, icon('link', 14)) : null,
        h('button', { class: 'rr-icon-btn', title: 'Stop this session (asks first)', 'aria-label': `Close ${subject(s)}`, onclick: () => askClose([s]) }, icon('close', 14)),
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
  const key = JSON.stringify([rows.map((s) => [{ ...s, lastSeenAt: '', updatedAt: '' }, s.startedAt && started(s.startedAt)]), [...selected], sort, failed, warnings, data?.generatedAt && relTime(data.generatedAt)]);
  if (key === painted) return;
  painted = key;
  meta.replaceChildren(h('span', { class: 'rr-pill', title: 'Sessions found across reviewroom, Crit and Plannotator' }, `${total} running`));
  if (rows.length !== total) meta.append(h('span', { class: 'rr-pill', title: 'Rows left after the filters' }, `${rows.length} shown`));
  if (data) meta.append(h('span', { class: 'rr-pill', title: `Refreshes every 2 s; last at ${new Date(data.generatedAt).toLocaleTimeString()}` }, `updated ${relTime(data.generatedAt)}`));
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
  for (const s of rows) seen.add(s.id);
  table.hidden = !rows.length;
  empty.hidden = !!rows.length;
  empty.textContent = total ? 'No sessions match the filters.' : 'No reviews running. Start one with `reviewroom pr`; Crit and Plannotator sessions show up here too.';
}

function fillSelects() {
  for (const [el, label, get] of selectOptions) {
    const values = [...new Set((data?.sessions ?? []).map(get).filter((v): v is string => !!v))].sort();
    const old = el.value;
    el.replaceChildren(h('option', { value: '' }, label), ...values.map((v) => h('option', { value: v }, v === NO_AUTHOR ? 'No author' : el === f.kind ? prettyKind(v) : el === f.tool ? (TOOLS[v] ?? v) : v)));
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
    h('header', { class: 'rr-thread__head' }, h('strong', null, items.length === 1 ? 'Close session?' : 'Close sessions?'), h('span', { class: 'rr-hub__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Cancel', title: 'Cancel', onclick: close }, icon('close', 14))),
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
