// The hub's page (`reviewroom hub`): every review on this machine, running or stopped, refreshed every 2 s from the
// hub's own server (a review server refuses requests from other ports). A snapshot strip of counts, facets, and one
// table grouped by repository (or author, tool); open, play, close; add a PR by URL, Play or Remove a stopped review
// (cli/hub/reviews.ts).
import { installButton } from '../kernel/install'; // first: it listens for Chrome's install prompt
import { avatarUrl, backdropCloses, diffstat, h, icon, plural, relTime, seg } from '../kernel/dom';
import { mountTooltips } from '../kernel/tooltip';
import { startUpdates } from '../kernel/pwa';
import { CRIT_LOGO, PLANNOTATOR_LOGO } from './logos';
import type { GenerationState, HubSnapshot, SessionInfo } from './model.shared';
// the agents' own marks (LobeHub icons, MIT), bundled as text
import claudeCode from '@lobehub/icons-static-svg/icons/claudecode-color.svg' with { type: 'text' };
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg' with { type: 'text' };
import copilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg' with { type: 'text' };
import geminiCli from '@lobehub/icons-static-svg/icons/geminicli-color.svg' with { type: 'text' };
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg' with { type: 'text' };
import kiro from '@lobehub/icons-static-svg/icons/kiro-color.svg' with { type: 'text' };
import amp from '@lobehub/icons-static-svg/icons/amp-color.svg' with { type: 'text' };
import pi from '@lobehub/icons-static-svg/icons/pi.svg' with { type: 'text' };
import { currentForm } from '../kernel/form';
import { addForm, inApp, ownAgent, play, remote, removeReview, type HubPage, type Notice } from './start';

type Compat = Record<string, { installed: string | null; verifiedAgainst: string; status: string }>;
type SortKey = 'subject' | 'state' | 'author' | 'reviewRound' | 'changes' | 'threads' | 'origin' | 'activity';
type GroupBy = 'repo' | 'author' | 'tool' | 'none';
type Facet = 'repo' | 'author' | 'tool';

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
const when = (iso: string) => (Date.now() - Date.parse(iso) < 7 * 86400e3 ? relTime(iso) : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
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
  if (s.reviewId) return s.reviewId;
  if (s.target && !/^https?:\/\//.test(s.target)) return base(s.target) || s.target;
  if (s.kind === 'code-review') return s.branch || s.repository || 'Code changes';
  return s.target || s.label || s.project || s.branch || s.repository || base(s.cwd) || s.id;
}
/** Tabs open on it: reviewroom counts them, Crit only knows whether any is. */
const tabs = (s: SessionInfo) => (s.browserClients === true ? 1 : typeof s.browserClients === 'number' ? s.browserClients : 0);
/** Last activity: reviewroom's state.json, the others' registry file; the start when neither is known. */
const activity = (s: SessionInfo) => s.updatedAt ?? s.startedAt;
const facetOf: Record<Facet, (s: SessionInfo) => string> = {
  repo: (s) => s.repository ?? 'No repository',
  author: (s) => s.author ?? 'No PR author',
  tool: (s) => TOOLS[s.tool] ?? s.tool,
};

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
let notice: Notice | null = null;
const selected = new Set<string>();
const sort: { key: SortKey; dir: 1 | -1 } = { key: 'activity', dir: -1 };
let group: GroupBy = 'repo';
const collapsed = new Set<string>();
const facet: Partial<Record<Facet, string>> = {};
let painted = '';
const seen = new Set<string>(); // sessions already shown: only new ones fade in

/** The snapshot's counts, each also a filter. */
const TILES: { id: string; label: string; tip: string; test: (s: SessionInfo) => boolean; value?: (rows: SessionInfo[]) => number; sub: (n: number, rows: SessionInfo[]) => string; tone?: string }[] = [
  { id: 'live', label: 'All', tip: 'Every review on this machine: reviewroom’s, running or stopped, and Crit and Plannotator sessions', test: () => true, sub: (_, rows) => `${rows.filter((s) => !s.stopped).length} running` },
  { id: 'tab', label: 'Open in a tab', tip: 'A browser tab is connected to it', test: (s) => tabs(s) > 0, sub: () => 'being read' },
  { id: 'open', label: 'Open threads', tip: 'Reviews with unresolved threads', test: (s) => (s.unresolvedCommentCount ?? 0) > 0, value: (rows) => rows.reduce((n, s) => n + (s.unresolvedCommentCount ?? 0), 0), sub: (_, rows) => `in ${plural(rows.filter((s) => (s.unresolvedCommentCount ?? 0) > 0).length, 'review')}`, tone: 'comment' },
  { id: 'round', label: 'Round 2+', tip: 'Reviews past their first round', test: (s) => (s.reviewRound ?? 0) >= 2, sub: () => 'reviews' },
  { id: 'down', label: 'Unreachable', tip: 'The session’s server did not answer the last check', test: (s) => s.health === 'unreachable', sub: () => 'not answering', tone: 'risk' },
];
let tile = 'live';

// ------------------------------------------------------------ elements
const q = h('input', { type: 'search', class: 'rr-input rr-hub__search', placeholder: 'Filter by title, PR, branch, author…', 'aria-label': 'Filter', title: 'Show only reviews containing this text: title, PR, repository, branch, directory, kind, pid or agent', oninput: () => paint() });
const meta = h('div', { class: 'rr-header__meta rr-hub__meta' });
const banners = h('div', { class: 'rr-hub__banners' });
const tileEls = TILES.map((t) => {
  const value = h('span', { class: 'rr-hub__tile-value' + (t.tone ? ` is-${t.tone}` : '') });
  const sub = h('span', { class: 'rr-hub__tile-sub' });
  const el = h('button', { class: 'rr-hub__tile', type: 'button', title: t.id === 'live' ? t.tip : `${t.tip}. Click to show only these`, onclick: () => { tile = tile === t.id ? 'live' : t.id; paint(); } }, h('span', { class: 'rr-hub__tile-label' }, t.label), h('span', { class: 'rr-hub__tile-num' }, value, sub));
  return { t, el, value, sub };
});
const GROUPS = [['repo', 'Repo', 'Group by repository'], ['author', 'Author', 'Group by pull request author'], ['tool', 'Tool', 'Group by review tool'], ['none', 'None', 'One list, no groups']] as const;
const groupCtl = seg(
  GROUPS.map(([id, label, title]) => ({
    label, title, on: group === id,
    onclick: () => {
      group = id;
      groupCtl.querySelectorAll('button').forEach((b, i) => { const on = GROUPS[i][0] === id; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
      paint();
    },
  })),
  { class: 'rr-seg rr-hub__group-by', 'aria-label': 'Group by' },
);
const facetLists = (['repo', 'author', 'tool'] as const).map((k) => [k, h('div', { class: 'rr-hub__facet-items' })] as const);
const narrow = matchMedia('(max-width: 1099px)');
const rail = h(
  'details',
  { class: 'rr-hub__rail', open: !narrow.matches },
  h('summary', { class: 'rr-hub__rail-toggle' }, icon('filter', 14), 'Filters and grouping'),
  h(
    'div',
    { class: 'rr-hub__rail-body' },
    h('div', { class: 'rr-hub__facet' }, h('span', { class: 'rr-hub__facet-label' }, 'Group by'), groupCtl),
    ...facetLists.map(([k, list]) => h('div', { class: 'rr-hub__facet' }, h('span', { class: 'rr-hub__facet-label' }, { repo: 'Repository', author: 'Author', tool: 'Tool' }[k]), list)),
  ),
);
narrow.addEventListener('change', () => (rail.open = !narrow.matches));

const shown = h('span', { class: 'rr-hub__shown' });
const count = h('span', { class: 'rr-hub__count' });
const openBtn = h('button', { class: 'rr-btn rr-btn--small rr-hub__bulk', disabled: true, title: 'Open the selected sessions in new tabs', onclick: () => chosen().forEach(open) }, icon('popout', 14), 'Open');
const closeBtn = h('button', { class: 'rr-btn rr-btn--small rr-hub__bulk', disabled: true, title: 'Stop the selected sessions (asks first)', onclick: () => askClose(chosen().filter((s) => !s.stopped)) }, icon('close', 14), 'Close…');
const clearBtn = h('button', { class: 'rr-btn rr-btn--ghost rr-btn--small', hidden: true, title: 'Clear every filter', onclick: () => { q.value = ''; tile = 'live'; for (const k of Object.keys(facet) as Facet[]) delete facet[k]; paint(); } }, 'Clear filters');
const all = h('input', { type: 'checkbox', class: 'rr-hub__check', 'aria-label': 'Select all shown', title: 'Select every session shown', onchange: () => { visible().forEach((s) => (all.checked ? selected.add(s.id) : selected.delete(s.id))); paint(); } });
const bar = h('div', { class: 'rr-hub__bar' }, shown, h('span', { class: 'rr-hub__spacer' }), count, openBtn, closeBtn, clearBtn);
const empty = h('div', { class: 'rr-empty rr-hub__empty' }, 'Looking for running reviews…');

const columns: [SortKey | null, string, string, string?][] = [
  ['subject', 'Review', 'What is under review: the title, PR, branch or file', 'c-review'],
  ['state', 'State', 'reviewroom: running or stopped (Play starts it), and where its walkthrough and report stand', 'c-state'],
  ['author', 'Author', 'Who opened the pull request on GitHub (only for reviews of a PR)', 'c-author'],
  ['reviewRound', 'Round', 'The review round it is on: each round ends when the reviewer sends feedback', 'c-round'],
  ['changes', '', 'Lines added and removed in the reviewed diff (reviewroom only)', 'c-diff'],
  ['threads', 'Threads', 'Open threads of all threads', 'c-threads'],
  ['origin', 'Agent', 'The agent CLI that started it', 'c-agent'],
  ['activity', 'Active', 'Last activity: a thread, a round, a reply', 'c-active'],
  [null, '', '', 'c-actions'],
];
const heads = columns.map(([key, label, tip, cls]) =>
  h(
    'th',
    { class: cls, scope: 'col', title: tip ? (key ? `${tip}. Click to sort` : tip) : undefined, onclick: key ? () => { sort.dir = sort.key === key ? (-sort.dir as 1 | -1) : key === 'activity' || key === 'changes' || key === 'threads' ? -1 : 1; sort.key = key; paint(); } : undefined, 'data-sort': key ?? undefined },
    label || h('span', { class: 'rr-hub__sr' }, key === 'changes' ? 'Lines changed' : 'Actions'),
  ),
);
const table = h('table', { class: 'rr-hub__table', hidden: true }, h('thead', null, h('tr', null, h('th', { class: 'rr-hub__sel', scope: 'col' }, all), ...heads)));

const hubPage: HubPage = { say: (n) => { notice = n; paint(true); }, refresh, subject, forget: (id) => selected.delete(id) };
const stateOf: Record<GenerationState, string> = { idle: 'not generated', generating: 'generating', ready: 'ready', stopped: 'generation stopped' };
const waitingText = { agent: 'waiting on the agent', reviewer: 'waiting on you' } as const;
/** Running or stopped, where generation stands and whose move it is (reviewroom only). */
const stateText = (s: SessionInfo) => [s.stopped ? 'Stopped' : 'Running', s.generation && stateOf[s.generation], s.waitingOn && waitingText[s.waitingOn]].filter(Boolean).join(' · ');

mountTooltips();
startUpdates(import.meta.url);
const root = h('div', { class: 'rr-root rr-hub' });
// a phone upright (or ?phone) gets the phone's layout (hub.phone.css); on its side, the table
const applyForm = () => root.classList.toggle('is-phone', currentForm() === 'phone');
applyForm();
addEventListener('resize', applyForm);
screen.orientation?.addEventListener('change', applyForm);
document.body.append(root);
root.append(
    h(
      'header',
      { class: 'rr-header' },
      h('div', { class: 'rr-header__id' }, h('div', { class: 'rr-mark', 'aria-hidden': 'true' }, 'rr'), h('div', { class: 'rr-header__titles' }, h('h1', { class: 'rr-header__title' }, 'All reviews'), meta)),
      h('div', { class: 'rr-toolbar__spacer' }),
      h('label', { class: 'rr-hub__find' }, icon('search', 14), q),
      installButton(true),
    ),
    h('div', { class: 'rr-hub__adder' }, addForm(hubPage)),
    banners,
    h('section', { class: 'rr-hub__strip', 'aria-label': 'Snapshot' }, ...tileEls.map((t) => t.el)),
    h(
      'div',
      { class: 'rr-hub__body' },
      rail,
      h(
        'main',
        { class: 'rr-hub__main' },
        bar,
        h('div', { class: 'rr-hub__scroll' }, table, empty),
      ),
    ),
);

// ------------------------------------------------------------ filtering, sorting, grouping
function visible(): SessionInfo[] {
  const text = q.value.trim().toLowerCase();
  const hay = (s: SessionInfo) => [s.id, subject(s), stateText(s), s.tool, s.category, s.kind, s.reviewId, prettyKind(s.kind), s.target, s.repository, s.repoRoot, s.branch, s.cwd, s.pid, s.parentAgentPid, s.origin, s.author, s.mode, s.label, s.project].join(' ').toLowerCase();
  const test = TILES.find((t) => t.id === tile)!.test;
  const rows = (data?.sessions ?? []).filter((s) => test(s) && (!text || hay(s).includes(text)) && (Object.keys(facet) as Facet[]).every((k) => facetOf[k](s) === facet[k]));
  const val = (s: SessionInfo): string | number | null => {
    switch (sort.key) {
      case 'subject': return subject(s);
      case 'state': return stateText(s);
      case 'activity': return Date.parse(activity(s) ?? '') || null;
      case 'changes': return s.additions == null ? null : s.additions + (s.deletions ?? 0);
      case 'threads': return s.commentCount == null ? null : (s.unresolvedCommentCount ?? 0) * 1e6 + s.commentCount; // open first, then total
      default: return s[sort.key];
    }
  };
  return rows.sort((a, b) => {
    const [x, y] = [val(a), val(b)];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // unknowns last
    return sort.dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));
  });
}
/** Groups in the order of their first row, so the sort decides which group leads. */
function groups(rows: SessionInfo[]): [string, SessionInfo[]][] {
  if (group === 'none') return [['', rows]];
  const by = new Map<string, SessionInfo[]>();
  for (const s of rows) {
    const k = facetOf[group](s);
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  return [...by];
}
const chosen = () => visible().filter((s) => selected.has(s.id));
const open = (s: SessionInfo) => s.url && window.open(s.url, '_blank', 'noopener');

// ------------------------------------------------------------ rendering
function row(s: SessionInfo) {
  const on = selected.has(s.id);
  const down = s.health === 'unreachable';
  const [agentName, mark] = s.origin ? (AGENTS[s.origin] ?? [s.origin]) : [];
  // a PR's Review ID (owner/repo#n), unless it is the title already
  const pr = s.reviewId && s.reviewId !== subject(s) ? s.reviewId : s.target?.startsWith('#') ? s.target : null;
  const where = [prettyKind(s.kind), s.cwd, s.pid != null && `pid ${s.pid}${s.port ? ` on port ${s.port}` : ''}`].filter(Boolean).join(' · ');
  const name = s.url
    ? h('a', { class: 'rr-hub__name', href: s.url, target: '_blank', rel: 'noopener', title: `${inApp ? 'Open in a tab here' : 'Open in a new tab'}: ${where}` }, subject(s))
    : h('span', { class: 'rr-hub__name', title: s.stopped ? `Stopped: Play starts it. ${where}` : `Cannot open: ${s.urlNote ?? 'no loopback URL'}. ${where}` }, subject(s));
  const openN = s.unresolvedCommentCount ?? 0;
  const threads = s.commentCount == null
    ? h('span', { class: 'rr-hub__dim', title: 'Not reported by this tool' }, '–')
    : h(
        'span',
        { class: 'rr-hub__threads', title: s.unresolvedCommentCount == null ? plural(s.commentCount, 'thread') : `${openN} open of ${plural(s.commentCount, 'thread')}` },
        h('span', { class: 'rr-hub__bar-track', 'aria-hidden': 'true' }, h('span', { style: { width: `${s.commentCount ? Math.round(((s.commentCount - openN) / s.commentCount) * 100) : 0}%` } })),
        h('span', { class: openN ? 'is-open' : '' }, s.unresolvedCommentCount == null ? String(s.commentCount) : `${openN} / ${s.commentCount}`),
      );
  const at = activity(s);
  return h(
    'tr',
    { class: [on && 'is-selected', !seen.has(s.id) && 'is-new', down && 'is-down'].filter(Boolean).join(' ') || undefined },
    h('td', { class: 'rr-hub__sel' }, h('input', { type: 'checkbox', class: 'rr-hub__check', checked: on, 'data-focus': `sel:${s.id}`, 'aria-label': `Select ${subject(s)}`, title: 'Select for Open or Close', onchange: () => { if (on) selected.delete(s.id); else selected.add(s.id); paint(); } })),
    h(
      'td',
      { class: 'c-review' },
      h(
        'div',
        { class: 'rr-hub__review' },
        h('span', { class: 'rr-hub__dot' + (s.stopped ? ' is-stopped' : down ? ' is-down' : tabs(s) ? ' is-tab' : ''), title: s.stopped ? 'Stopped: no server runs for it; Play starts it' : down ? 'Not answering: its server may be busy or stopped' : tabs(s) ? `Live, ${plural(tabs(s), 'tab')} open` : 'Live, no tab open' }),
        toolMark(s.tool),
        name,
        pr ? h('span', { class: 'rr-hub__mono rr-hub__dim' }, pr) : null,
        s.branch ? h('span', { class: 'rr-hub__mono rr-hub__dim rr-hub__branch', title: s.worktree ? `${s.branch}, in a linked worktree` : s.branch }, s.branch, s.worktree ? ' wt' : '') : null,
        group !== 'repo' && s.repository ? h('span', { class: 'rr-hub__dim rr-hub__branch' }, s.repository) : null,
      ),
    ),
    h('td', { class: 'c-state' }, h('span', { class: `rr-pill${s.generation === 'ready' ? ' rr-pill--ok' : ''}`, title: s.stopped ? 'No server runs for this review: Play starts it' : 'Its server is running' }, stateText(s))),
    h(
      'td',
      { class: 'c-author' },
      s.author
        ? h('span', { class: 'rr-hub__author', title: `@${s.author} opened this pull request` }, h('img', { class: 'rr-avatar rr-avatar--gh rr-hub__avatar', src: avatarUrl(`https://avatars.githubusercontent.com/${s.author}`, 40), alt: '', loading: 'lazy' }), s.author)
        : h('span', { class: 'rr-hub__dim' }, '–'),
    ),
    h('td', { class: 'c-round', title: s.reviewRound == null ? 'Not reported by this tool' : `Round ${s.reviewRound}` }, s.reviewRound == null ? h('span', { class: 'rr-hub__dim' }, '–') : `R${s.reviewRound}`),
    h('td', { class: 'c-diff' }, s.additions == null ? null : diffstat([{ additions: s.additions, deletions: s.deletions ?? 0 }], { small: true, title: plural(s.changedFiles ?? 0, 'file') })),
    h('td', { class: 'c-threads' }, threads),
    h('td', { class: 'c-agent' }, s.origin ? h('span', { class: 'rr-hub__agent', title: `${agentName}, pid ${s.parentAgentPid}: ${s.originSource ?? ''}` }, mark ? h('span', { class: 'rr-hub__mark', html: mark.replace(/<title>.*?<\/title>/, ''), 'aria-label': agentName }) : agentName) : h('span', { class: 'rr-hub__dim', title: 'No agent CLI found among its parent processes' }, '–')),
    h('td', { class: 'c-active', title: [at && `Last activity ${new Date(at).toLocaleString()}`, s.startedAt && `started ${new Date(s.startedAt).toLocaleString()}`].filter(Boolean).join(', ') || 'Not recorded' }, at ? when(at) : '–'),
    h(
      'td',
      { class: 'c-actions' },
      h(
        'div',
        { class: 'rr-hub__actions' },
        s.stopped ? h('button', { class: 'rr-icon-btn is-play', title: 'Play: start this review and open it; the built-in assistant writes its walkthrough and report', 'aria-label': `Play ${subject(s)}`, onclick: () => void play(hubPage, s) }, icon('play', 14)) : null,
        s.stopped ? h('button', { class: 'rr-icon-btn', title: 'Use my own agent: a prompt to paste into your agent, which writes the review instead', 'aria-label': `Use my own agent for ${subject(s)}`, onclick: () => ownAgent(s) }, icon('copy', 14)) : null,
        s.url && s.walkthrough ? h('a', { class: 'rr-icon-btn is-play', href: `${s.url}?walkthrough`, target: '_blank', rel: 'noopener', title: 'Play the walkthrough', 'aria-label': `Play the walkthrough of ${subject(s)}` }, icon('play', 14)) : null,
        s.url ? h('a', { class: 'rr-icon-btn', href: s.url, target: '_blank', rel: 'noopener', title: inApp ? 'Open in a tab here' : 'Open in a new tab', 'aria-label': `Open ${subject(s)}` }, icon('popout', 14)) : null,
        // #rr-browser: the app hands this one to the browser instead
        inApp && s.url ? h('a', { class: 'rr-icon-btn', href: `${s.url}#rr-browser`, target: '_blank', rel: 'noopener', title: 'Open in the browser', 'aria-label': `Open ${subject(s)} in the browser` }, icon('link', 14)) : null,
        s.stopped
          ? h('button', { class: 'rr-icon-btn', title: s.hasWork ? 'Remove this review and its artifacts (asks first)' : 'Remove this review', 'aria-label': `Remove ${subject(s)}`, onclick: () => removeReview(hubPage, s) }, icon('trash', 14))
          : h('button', { class: 'rr-icon-btn', title: 'Stop this session (asks first)', 'aria-label': `Close ${subject(s)}`, onclick: () => askClose([s]) }, icon('close', 14)),
      ),
    ),
  );
}

/** A group's header row: its name and totals, a button that folds it. */
function groupHead(name: string, rows: SessionInfo[]) {
  const shut = collapsed.has(name);
  const openThreads = rows.reduce((n, s) => n + (s.unresolvedCommentCount ?? 0), 0);
  const down = rows.filter((s) => s.health === 'unreachable').length;
  const latest = rows.map(activity).filter((t): t is string => !!t).sort().pop();
  return h(
    'tr',
    { class: 'rr-hub__group' },
    h(
      'th',
      { colspan: String(columns.length + 1), scope: 'rowgroup' },
      h(
        'button',
        { type: 'button', class: 'rr-hub__group-btn', 'aria-expanded': String(!shut), 'data-focus': `group:${name}`, title: shut ? 'Show this group’s reviews' : 'Fold this group', onclick: () => { if (shut) collapsed.delete(name); else collapsed.add(name); paint(); } },
        icon(shut ? 'chevron' : 'chevronDown', 12),
        h('span', { class: group === 'repo' ? 'rr-hub__group-name rr-hub__mono' : 'rr-hub__group-name' }, name),
        h('span', { class: 'rr-hub__dim' }, plural(rows.length, 'review') + (latest ? ` · active ${when(latest)}` : '')),
        h('span', { class: 'rr-hub__spacer' }),
        openThreads ? h('span', { class: 'rr-hub__group-open' }, plural(openThreads, 'open thread')) : null,
        down ? h('span', { class: 'rr-hub__group-down' }, `${down} unreachable`) : null,
      ),
    ),
  );
}

function paintFacets(sessions: SessionInfo[]) {
  for (const [k, list] of facetLists) {
    const counts = new Map<string, number>();
    for (const s of sessions) counts.set(facetOf[k](s), (counts.get(facetOf[k](s)) ?? 0) + 1);
    if (facet[k] && !counts.has(facet[k])) delete facet[k]; // its sessions all ended
    list.replaceChildren(
      ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) =>
        h(
          'button',
          { type: 'button', class: 'rr-hub__facet-item' + (facet[k] === v ? ' is-on' : ''), 'aria-pressed': String(facet[k] === v), 'data-focus': `facet:${k}:${v}`, title: facet[k] === v ? 'Show every one again' : `Show only ${v}`, onclick: () => { if (facet[k] === v) delete facet[k]; else facet[k] = v; paint(); } },
          h('span', { class: k === 'repo' ? 'rr-hub__facet-name rr-hub__mono' : 'rr-hub__facet-name' }, v),
          h('span', { class: 'rr-hub__facet-n' }, String(n)),
        ),
      ),
    );
  }
}

function paint(force = false) {
  if (force) painted = '';
  const sessions = data?.sessions ?? [];
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  const rows = visible();
  const total = sessions.length;
  const picked = rows.filter((s) => selected.has(s.id));
  // re-render only on change: a 2 s refresh must not steal focus or a hover
  const key = JSON.stringify([
    rows.map((s) => [{ ...s, lastSeenAt: '' }, activity(s) && when(activity(s)!)]),
    [...selected], sort, group, [...collapsed], tile, facet, failed, warnings, data?.generatedAt && relTime(data.generatedAt), notice,
  ]);
  if (key === painted) return;
  const focus = (document.activeElement as HTMLElement | null)?.dataset.focus; // rebuilt controls get it back
  painted = key;

  const stopped = sessions.filter((s) => s.stopped).length;
  meta.textContent = `${total - stopped} running` + (stopped ? ` · ${stopped} stopped` : '') + (data ? ` · updated ${relTime(data.generatedAt)}` : '');
  if (data) meta.title = `Refreshes every 2 s; last at ${new Date(data.generatedAt).toLocaleTimeString()}`;
  banners.replaceChildren(
    ...(failed ? [h('div', { class: 'rr-hub__banner rr-hub__banner--risk', role: 'alert' }, failed)] : []),
    ...(notice ? [h('div', { class: `rr-hub__banner${notice.risk ? ' rr-hub__banner--risk' : ''}`, role: notice.risk ? 'alert' : 'status' }, notice.text, notice.link ? h('a', { href: notice.link, target: '_blank', rel: 'noopener' }, ' open it') : null)] : []),
    ...warnings.map((w) => h('div', { class: 'rr-hub__banner' }, w)),
  );
  for (const { t, el, value, sub } of tileEls) {
    const matching = sessions.filter(t.test);
    const n = t.value ? t.value(sessions) : matching.length;
    value.textContent = String(n);
    value.classList.toggle('is-zero', !n);
    sub.textContent = t.sub(n, sessions);
    el.classList.toggle('is-on', tile === t.id);
    el.setAttribute('aria-pressed', String(tile === t.id));
  }
  paintFacets(sessions);

  shown.textContent = rows.length === total ? plural(total, 'review') : `${rows.length} of ${plural(total, 'review')}`;
  count.textContent = picked.length ? `${picked.length} selected` : '';
  openBtn.disabled = !picked.some((s) => s.url);
  closeBtn.disabled = !picked.some((s) => !s.stopped);
  clearBtn.hidden = tile === 'live' && !q.value && !Object.keys(facet).length;
  bar.classList.toggle('is-filtered', !clearBtn.hidden);
  all.checked = !!rows.length && picked.length === rows.length;
  all.indeterminate = picked.length > 0 && picked.length < rows.length;
  heads.forEach((th) => (th.dataset.sort === sort.key ? th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort')));

  table.querySelectorAll('tbody').forEach((b) => b.remove());
  for (const [name, list] of groups(rows)) {
    const body = h('tbody');
    if (group !== 'none') body.append(groupHead(name, list));
    if (group === 'none' || !collapsed.has(name)) body.append(...list.map(row));
    table.append(body);
  }
  for (const s of rows) seen.add(s.id);
  table.hidden = !rows.length;
  empty.hidden = !!rows.length;
  empty.textContent = total ? 'No reviews match the filters.' : 'No reviews yet. Add a PR above, or start one with `reviewroom pr`; Crit and Plannotator sessions show up here too.';
  if (focus) document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
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
    if (remote) for (const s of data.sessions) [s.url, s.urlNote] = s.routeId && !s.stopped ? [`/r/${s.routeId}/`, null] : [null, 'only reachable on the machine itself'];
    const health = hr.ok ? ((await hr.json()) as { compatibility?: Compat }) : null;
    const compat = Object.entries(health?.compatibility ?? {})
      .filter(([tool, c]) => c.status === 'unverified' || (c.status === 'unavailable' && data!.sessions.some((s) => s.tool === tool)))
      .map(([tool, c]) => `${TOOLS[tool]} ${c.installed ?? '(version unknown)'} is not the version the hub was checked against (${c.verifiedAgainst}); its sessions may show less.`);
    warnings = [data.lastError, ...compat].filter((w): w is string => !!w);
    failed = '';
  } catch (e) {
    failed = `The hub is not answering (${(e as Error).message}). Start it again with \`reviewroom hub\`.`;
  }
  paint();
}

setInterval(refresh, 2000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
void refresh();
