// Top bar: identity, rounds, search, picker, layout, theme, send feedback.
import { append, h, icon, copyText, relTime, placeNear, backdropCloses } from '../core/dom';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
import { keyLabel, modLabel } from '../core/commands';
import { feedbackMarkdown } from '../shared/feedback';
import { applyLayout, canUndoLayout, closePanel, deleteLayout, ensurePanel, hasPanel, layouts, panelDefs, resetLayout, saveLayout, setDefaultLayout, undoLayout } from './layout';
import type { ReviewApp } from './app';
import { canInstall, install, installButton } from './install';
import { updateReady } from './pwa';
import type { GitHubAction } from '../shared/schema';

// ---------------------------------------------------------------- tiny menu
export function popMenu(anchor: HTMLElement, build: (close: () => void) => (HTMLElement | null)[]) {
  document.querySelectorAll<HTMLElement>('.rr-menu').forEach((m) => m.hidePopover());
  // a popover: click-away and Esc close it; it's removed once closed
  const menu = h('div', { class: 'rr-menu', role: 'menu', popover: 'auto', onkeydown: arrows, ontoggle: (e: ToggleEvent) => {
    anchor.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState === 'closed') menu.remove();
  } });
  const close = () => menu.hidePopover();
  menu.append(...(build(close).filter(Boolean) as HTMLElement[]));
  (anchor.closest('dialog') ?? document.body).append(menu); // outside an open modal dialog it would be inert
  menu.showPopover();
  void placeNear(anchor, menu, 'bottom-end', 6, 8);
  (menu.querySelector('button') as HTMLElement | null)?.focus();
  return close;
}
/** Up/Down/Home/End between a menu's items. */
function arrows(e: KeyboardEvent) {
  const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to = ({ ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: -1 } as Record<string, number>)[e.key];
  if (to === undefined || !items.length) return;
  e.preventDefault();
  items.at(to % items.length)?.focus();
}
export const menuItem = (label: string | Node, fn: () => void, opts: { hint?: string; checked?: boolean; icon?: Parameters<typeof icon>[0] } = {}) =>
  h('button', { class: 'rr-menu__item', role: 'menuitem', onclick: fn }, h('span', { class: 'rr-menu__check' }, opts.checked ? icon('check', 12) : opts.icon ? icon(opts.icon, 14) : ''), h('span', { class: 'rr-menu__label' }, label), opts.hint ? h('span', { class: 'rr-menu__hint' }, opts.hint) : null);
export const menuLabel = (t: string) => h('div', { class: 'rr-menu__label-row' }, t);

// ---------------------------------------------------------------- send dialogs
/** A narrow modal dialog (title, close button, body, footer), removed once closed; `note` gets the focus.
 *  `act` wraps a footer action: one at a time (a double click must not do it twice), closing when it returns true. */
type Act = (fn: () => Promise<boolean>) => () => Promise<void>;
function noteDialog(label: string, title: string, note: HTMLElement, content: (act: Act, close: () => void) => [body: (HTMLElement | null)[], foot: HTMLElement[]]) {
  const close = () => box.close();
  const act: Act = (fn) => async () => {
    const buttons = [...box.querySelectorAll<HTMLButtonElement>('footer button')];
    if (buttons.some((b) => b.disabled)) return;
    buttons.forEach((b) => (b.disabled = true));
    if (await fn()) close();
    else buttons.forEach((b) => (b.disabled = false));
  };
  const [body, foot] = content(act, close);
  const box = h(
    'dialog',
    { class: 'rr-modal rr-modal--narrow', 'aria-label': label, onmousedown: backdropCloses, onclose: () => box.remove() },
    h('header', { class: 'rr-thread__head' }, h('strong', null, title), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 14))),
    h('div', { class: 'rr-send__body' }, ...body),
    h('footer', { class: 'rr-composer__foot' }, ...foot),
  );
  document.body.append(box);
  box.showModal();
  note.focus();
}

export function sendDialog(app: ReviewApp) {
  const pending = app.pendingFeedback();
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Overall note for the agent (optional, markdown)' });
  const go = (kind: 'feedback' | 'approve') => async () => {
    const n = app.state.round;
    const text = note.value.trim() || undefined;
    if (app.backend.finish) {
      const res = await app.backend.finish(kind, text, n).catch((e) => ({ ok: false, message: String(e) }));
      if (!res.ok) {
        app.toast('Failed: ' + (res.message ?? 'unknown'), 'error');
        return false;
      }
      app.toast(kind === 'approve' ? 'Approved' : `Round ${n} sent`);
    } else {
      await copyText(feedbackMarkdown(app.state, { kind, note: text, walkthrough: app.walkthrough }));
      app.apply({ op: 'finishRound', kind, note: text, round: n });
      app.toast('Feedback copied — paste it to your agent');
    }
    return true;
  };
  noteDialog(
    'Finish round',
    `Finish round ${app.state.round}`,
    note,
    (act, close) => [
      [
        h('p', { class: 'rr-muted' }, pending.length ? `${plural(pending.length, 'thread')} with new comments:` : 'No new comments this round.'),
        h('ul', { class: 'rr-send__list' }, ...pending.map((t) => h('li', null, h('span', { class: 'rr-chip rr-chip--static' }, app.anchorLabel(t.anchor)), ' ', plural(t.messages.filter((m) => m.author === 'you' && m.round === app.state.round).length, 'comment')))),
        note,
        app.backend.finish ? null : h('p', { class: 'rr-muted rr-small' }, 'Feedback will be copied for you to paste to your agent.'),
      ],
      [h('button', { class: 'rr-btn rr-btn--ghost', onclick: act(go('approve')) }, icon('check', 12), 'Approve'), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-btn rr-btn--ghost', onclick: close }, 'Cancel'), h('button', { class: 'rr-btn rr-btn--primary', onclick: act(go('feedback')) }, icon('send', 12), 'Send feedback')],
    ],
  );
}

// ---------------------------------------------------------------- save a named layout
/** Name the panels as they are now; as the default, the name starts as “Default” (taken: pick another). */
export function saveLayoutDialog(app: ReviewApp, asDefault = false) {
  const name = h('input', { class: 'rr-composer__input', placeholder: 'Layout name', 'aria-label': 'Layout name', value: asDefault ? 'Default' : '', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && save.click() });
  const save = h('button', { class: 'rr-btn rr-btn--primary', title: 'Save the panels as they are now' }, 'Save');
  const what = asDefault ? 'The panels as they are now, for reviews without a layout of their own to open with.' : 'The panels as they are now, to pick from the layout menu in any review.';
  noteDialog('Save layout', asDefault ? 'Save layout as default' : 'Save layout as', name, (act, close) => {
    save.onclick = act(() => saveLayout(app, name.value.trim(), asDefault));
    return [[h('p', { class: 'rr-muted' }, what + ' Names already in use are refused.'), name], [h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-btn rr-btn--ghost', onclick: close }, 'Cancel'), save]];
  });
  name.select();
}

// ---------------------------------------------------------------- submit GitHub review
export function submitReviewDialog(app: ReviewApp) {
  const drafts = app.github?.pending?.drafts ?? 0;
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Review summary (optional, markdown)' });
  const go = (done: string, action: () => GitHubAction) => async () => (await app.githubAct(action())) && (app.toast(done), true);
  const submit = (event: Extract<GitHubAction, { action: 'submit' }>['event'], done: string) => go(done, () => ({ action: 'submit', event, body: note.value }));
  noteDialog(
    'Submit review on GitHub',
    'Submit your review on GitHub',
    note,
    (act) => [
      [
        h('p', { class: 'rr-muted' }, drafts ? `${plural(drafts, 'draft comment')} will be posted with it, visible to everyone on the PR.` : 'No draft comments: this posts just the summary and your verdict.'),
        note,
        drafts ? h('button', { class: 'rr-link-btn', title: 'Delete every draft comment in this review', onclick: act(go('Drafts discarded', () => ({ action: 'discard' }))) }, 'Discard all drafts') : null,
      ],
      [
        h('button', { class: 'rr-btn rr-btn--ghost', title: 'Ask for changes before this can merge', onclick: act(submit('request_changes', 'Review submitted: changes requested')) }, 'Request changes'),
        h('button', { class: 'rr-btn rr-btn--ghost', onclick: act(submit('approve', 'Review submitted: approved')) }, icon('check', 12), 'Approve'),
        h('span', { class: 'rr-toolbar__spacer' }),
        h('button', { class: 'rr-btn rr-btn--primary', title: 'Post your comments without approving or blocking', onclick: act(submit('comment', 'Review submitted')) }, icon('send', 12), 'Comment'),
      ],
    ],
  );
}

/** GitHub status + the Agent/Team switch: shown only for reviews of a GitHub PR. */
function githubControls(app: ReviewApp) {
  const g = app.github;
  if (!g || !app.onGitHub) return [];
  const warn = !!g.error || !!g.stale;
  const btn = h(
    'button',
    { class: 'rr-hbtn' + (warn ? ' is-warn' : ''), 'aria-haspopup': 'menu', title: g.error ? 'GitHub: ' + g.error : g.stale ? 'The PR has new commits on GitHub' : `GitHub threads, as @${g.viewer}` },
    icon('thread', 14),
    h('span', null, g.error ? 'GitHub offline' : g.stale ? 'PR updated' : 'GitHub'),
    icon('chevronDown', 12),
  );
  btn.onclick = () =>
    popMenu(btn, (close) => [
      menuLabel(g.ok ? `Signed in as @${g.viewer} · fetched ${relTime(g.at ?? '')}` : 'GitHub'),
      g.error ? h('div', { class: 'rr-menu__note' }, g.error) : null,
      g.stale ? h('div', { class: 'rr-menu__note' }, `The PR has commits you aren't reviewing yet. Run \`reviewroom pr ${app.meta.number ?? '<n>'}\` again to update; comments still land on the right lines meanwhile.`) : null,
      menuItem('Refresh comments', () => (close(), app.refreshGitHub().then(() => app.toast('GitHub comments refreshed')))),
      g.url ? menuItem('Open the PR on GitHub', () => (close(), window.open(g.url, '_blank', 'noopener')), { icon: 'popout' }) : null,
    ]);
  return g.ok ? [btn, reviewModeSwitch(app)] : [btn];
}

/** Agent / Team / All: where new comments go and which threads are listed (a GitHub PR's review mode). */
function reviewModeSwitch(app: ReviewApp) {
  return h(
    'div',
    { class: 'rr-seg rr-seg--small', role: 'group', 'aria-label': 'Review mode: where new comments go and which threads are listed' },
    ...(['agent', 'team', 'all'] as const).map((m) =>
      h(
        'button',
        {
          class: app.prefs.reviewMode === m ? 'is-on' : '',
          'aria-pressed': String(app.prefs.reviewMode === m),
          title: {
            agent: 'Agent review: your comments go to the agent, round by round; Threads lists the agent threads',
            team: "Team review: code and PR comments go to GitHub, for colleagues (narrative comments still go to the agent); Threads lists GitHub's threads",
            all: 'All: Threads lists agent and GitHub threads together; code and PR comments can go to either',
          }[m],
          onclick: () => app.setPref('reviewMode', m),
        },
        { agent: 'Agent', team: 'Team', all: 'All' }[m],
      ),
    ),
  );
}

// ---------------------------------------------------------------- header
/** Review rounds: view the narrative as it was at the end of an earlier round. */
function roundMenu(app: ReviewApp, anchor: HTMLElement) {
  popMenu(anchor, (close) => [
    menuLabel('Review rounds'),
    ...app.state.rounds
      .slice()
      .reverse()
      .map((r) =>
        menuItem(
          `Round ${r.n}`,
          () => {
            close();
            app.bus.emit('round-view', r.n === app.state.round ? 0 : r.n);
          },
          { checked: (app.viewRound || app.state.round) === r.n, hint: r.status === 'open' ? 'current' : r.status },
        ),
      ),
  ]);
}

/** Where the round is at (waiting, approved, offline, not saved); the root's classes show one. */
const roundStatus = () => [
  h('span', { class: 'rr-round-status rr-round-status--waiting', title: 'Your feedback went to the agent. The next round opens here when it is back' }, 'Waiting for the agent…'),
  h('span', { class: 'rr-pill rr-pill--ok rr-round-status rr-round-status--approved', title: 'You approved this review; the reviewroom server has stopped' }, 'Approved'),
  h('span', { class: 'rr-pill rr-pill--draft rr-round-status rr-round-status--offline', title: 'The reviewroom server stopped. Changes stay in this tab and are saved when it is back' }, 'Disconnected'),
  h('span', { class: 'rr-pill rr-pill--draft rr-unsaved', title: 'The reviewroom server has not stored your latest changes. Reviewroom keeps retrying; keep this tab open' }, 'Not saved yet'),
];

/** Send feedback (or, in Team mode, submit the GitHub review), with the count of what it sends. */
function sendButton(app: ReviewApp) {
  const round = app.state.rounds.find((r) => r.n === app.state.round);
  const pending = app.pendingFeedback().length;
  return app.teamMode
    ? h(
        'button',
        { class: 'rr-btn rr-btn--primary rr-send-btn', title: 'Post your draft comments to GitHub as one review: comment, approve or request changes', onclick: () => submitReviewDialog(app) },
        icon('send', 14),
        h('span', null, 'Submit review'),
        app.github?.pending?.drafts ? h('span', { class: 'rr-badge' }, String(app.github.pending.drafts)) : null,
      )
    : h(
        'button',
        { class: 'rr-btn rr-btn--primary rr-send-btn', title: app.backend.finish ? 'Finish this round: the agent gets your new comments and starts the next round' : 'Copy this round’s comments as markdown to paste to your agent', 'data-keys': 'mod+shift+enter', onclick: () => sendDialog(app), disabled: round?.status !== 'open' && !!round },
        icon('send', 14),
        h('span', null, app.backend.finish ? 'Send feedback' : 'Export feedback'),
        pending ? h('span', { class: 'rr-badge' }, String(pending)) : null,
      );
}

const themeName = (app: ReviewApp) => (app.prefs.theme === 'system' ? 'follows your system' : app.prefs.theme);
const cycleTheme = (app: ReviewApp) => app.setPref('theme', app.prefs.theme === 'system' ? (app.resolvedTheme() === 'dark' ? 'light' : 'dark') : app.prefs.theme === 'dark' ? 'light' : 'system');
const hubHref = () => (location.pathname.startsWith('/r/') ? '/' : '/api/hub');
const playable = (app: ReviewApp) => !!(app.walkthrough || app.walkthroughIssues);
const playTitle = (app: ReviewApp) => (app.walkthroughIssues ? `walkthrough.json is invalid: ${app.walkthroughIssues[0]}` : 'Play the guided walkthrough: the main story of this diff, slide by slide');

/** Every header repaints on these. */
function repaintOn(app: ReviewApp, paint: () => void) {
  app.bus.on('state', paint);
  app.bus.on('prefs', paint);
  app.bus.on('theme', paint);
  app.bus.on('files', paint);
  app.bus.on('picker', (on) => {
    app.root.classList.toggle('is-picking', on);
    paint();
  });
  app.bus.on('round-view', () => setTimeout(paint));
  app.bus.on('walkthrough', paint);
  paint();
}

export function buildHeader(app: ReviewApp): HTMLElement {
  const m = app.meta;
  const bar = h('header', { class: 'rr-header' });
  const paint = () => {
    const themeIcon = app.resolvedTheme() === 'dark' ? 'moon' : 'sun';
    const roundBtn = h('button', { class: 'rr-hbtn', 'aria-haspopup': 'menu', title: 'Review rounds: view the narrative as it was at the end of an earlier round' }, icon('round', 14), h('span', null, `Round ${app.state.round}`), icon('chevronDown', 12));
    roundBtn.onclick = () => roundMenu(app, roundBtn);
    const layoutBtn = h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Layout', title: 'Layouts: pick, save or reset one, and choose which panels are open', 'aria-haspopup': 'menu' }, icon('layout', 16));
    const mine = () => Object.keys(app.layouts);
    layoutBtn.onclick = () => {
      const def = app.defaultLayout ? layouts(app)[app.defaultLayout] : undefined;
      popMenu(layoutBtn, (close) => [
        canUndoLayout() ? menuItem('Undo layout change', () => (close(), undoLayout(app)), { icon: 'undo', hint: 'back to how it was' }) : null,
        menuItem('Reset layout', () => (close(), resetLayout(app)), { icon: 'round', hint: def ? `back to “${def.title}”` : 'every panel back in place' }),
        menuItem('Save layout as default…', () => (close(), saveLayoutDialog(app, true)), { icon: 'pin', hint: 'new reviews open like this' }),
        def ? menuItem('Forget default layout', () => (close(), void setDefaultLayout(app, null)), { icon: 'close', hint: `“${def.title}” stays saved` }) : null,
        menuItem('Save layout as…', () => (close(), saveLayoutDialog(app)), { hint: 'pick it here in any review' }),
        mine().length ? menuItem('Delete a saved layout…', () => (close(), popMenu(layoutBtn, (done) => mine().map((id) => menuItem(app.layouts[id].title, () => (done(), void deleteLayout(app, id)), { icon: 'close' }))))) : null,
        menuLabel('Layouts'),
        ...Object.entries(layouts(app)).map(([id, l], i) => menuItem(l.title, () => (close(), applyLayout(app, id)), { checked: id === app.defaultLayout, hint: [id === app.defaultLayout ? 'default' : '', i < 9 ? keyLabel(`alt+${i + 1}`) : ''].filter(Boolean).join(' · ') || undefined })),
        menuLabel('Panels'),
        ...panelDefs()
          .filter((d) => !d.onDemand)
          .map((d) => menuItem(d.title, () => (close(), hasPanel(app, d.id) ? closePanel(app, d.id) : ensurePanel(app, d.id)), { checked: hasPanel(app, d.id) })),
      ]);
    };
    const picking = app.root.classList.contains('is-picking');
    bar.replaceChildren(
      h(
        'div',
        { class: 'rr-header__id' },
        h('div', { class: 'rr-mark', 'aria-hidden': 'true' }, 'rr'),
        h(
          'div',
          { class: 'rr-header__titles' },
          h('div', { class: 'rr-header__title', title: m.title }, m.number ? h('span', { class: 'rr-muted' }, `#${m.number} `) : null, m.title),
          h(
            'div',
            { class: 'rr-header__meta' },
            m.repo ? h('span', { class: 'rr-pill', title: 'Repository' }, m.repo) : null,
            m.author ? h('span', { class: 'rr-pill', title: 'Author of the change' }, 'by ' + m.author) : null,
            h('span', { class: 'rr-pill rr-pill--mono', title: `Diff of ${m.headLabel ?? m.head} against ${m.baseLabel ?? m.base} (merge base ${short(m.base)})` }, `${m.baseLabel ?? short(m.base)} ← ${m.headLabel ?? short(m.head)}`),
            h('span', { class: 'rr-pill', title: 'Files changed' }, `${app.files.length} files`),
          ),
        ),
      ),
      h('div', { class: 'rr-toolbar__spacer' }),
      h(
        'div',
        { class: 'rr-header__actions' },
        ...roundStatus(),
        app.backend.kind === 'server' ? h('a', { class: 'rr-hbtn', href: hubHref(), target: '_blank', title: 'Every review running on this machine: reviewroom, Crit and Plannotator' }, 'All reviews') : null,
        h('button', { class: 'rr-search-btn', onclick: () => app.openPalette(''), title: 'Jump to a file, section, thread or command. Type # for symbols, / to search code', 'data-keys': 'mod+k' }, icon('search', 14), h('span', null, 'Jump to…'), h('kbd', null, `${modLabel}K`)),
        ...githubControls(app),
        playable(app)
          ? h('button', { class: 'rr-hbtn rr-tour-btn', title: playTitle(app), 'data-keys': app.walkthrough ? 'g w' : null, disabled: !app.walkthrough, onclick: () => app.bus.emit('walkthrough-open', {}) }, icon('play', 14), h('span', null, 'Guided walkthrough'))
          : null,
        app.teamMode ? null : roundBtn,
        h('button', { class: 'rr-hbtn rr-hbtn--icon' + (picking ? ' is-on' : ''), title: 'Pick any element in the narrative to comment on (or hold Alt while hovering)', 'data-keys': 'x', 'aria-label': 'Pick element to comment', onclick: () => app.bus.emit('picker', !app.root.classList.contains('is-picking')) }, icon('target', 16)),
        layoutBtn,
        installButton(),
        h('button', { class: 'rr-hbtn rr-hbtn--icon', title: `Theme: ${themeName(app)}. Click to switch`, 'aria-label': 'Toggle theme', onclick: () => cycleTheme(app) }, icon(themeIcon, 16)),
        sendButton(app),
      ),
    );
  };
  repaintOn(app, paint);
  return bar;
}

/** Send on a phone: a round ink icon button, its count a badge on the corner (phone.css). */
function phoneSend(app: ReviewApp) {
  const b = sendButton(app);
  b.title = app.teamMode ? 'Submit review' : 'Send round';
  b.setAttribute('aria-label', b.title);
  b.querySelector('.rr-icon')?.replaceWith(icon('send', 24));
  return b;
}

/** The phone's status bar: menu, the review's title over "repo · Round N" (tap: rounds), search, play, send. */
export function buildPhoneBar(app: ReviewApp): HTMLElement {
  const m = app.meta;
  const bar = h('header', { class: 'rr-header rr-phonebar' });
  const paint = () => {
    const picking = app.root.classList.contains('is-picking');
    const menuBtn = h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Menu', title: 'Menu: all reviews, theme, install, pick an element to comment on', onclick: () => openDrawer(app) }, icon('menu', 24));
    const sub = [m.repo?.split('/').pop(), app.teamMode ? 'Team review' : `Round ${app.viewRound && app.viewRound !== app.state.round ? app.viewRound + ' of ' + app.state.round : app.state.round}`].filter(Boolean).join(' · ');
    const titles = h(
      'button',
      { class: 'rr-phonebar__titles', 'aria-haspopup': app.teamMode ? null : 'menu', title: app.teamMode ? m.title : 'Review rounds: view the narrative as it was at the end of an earlier round' },
      h('span', { class: 'rr-phonebar__title' }, m.title),
      h('span', { class: 'rr-phonebar__sub' }, h('span', null, sub), ...roundStatus()),
    );
    titles.onclick = () => !app.teamMode && roundMenu(app, titles);
    bar.replaceChildren();
    append(bar, [
      menuBtn,
      titles,
      // no Esc key on a phone: while picking, Cancel stands in for search
      picking
        ? h('button', { class: 'rr-hbtn is-on', title: 'Stop picking', onclick: () => app.bus.emit('picker', false) }, icon('target', 16), h('span', null, 'Cancel'))
        : h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Search', title: 'Search files, sections, symbols, threads and actions', onclick: () => app.openPalette('') }, icon('search', 24)),
      app.walkthrough ? h('button', { class: 'rr-hbtn rr-hbtn--icon rr-tour-btn', 'aria-label': 'Play guided review', title: playTitle(app), onclick: () => app.bus.emit('walkthrough-open', {}) }, icon('play', 24)) : null,
      phoneSend(app),
    ]);
  };
  repaintOn(app, paint);
  return bar;
}

/** The phone's menu: a drawer from the left with the review's facts and what the desktop header has that a phone
 *  still needs (no layouts: a phone has none). A modal dialog, so Esc, a tap outside and Back close it. */
export function openDrawer(app: ReviewApp) {
  const m = app.meta;
  const g = app.github;
  const close = () => box.close();
  const item = (label: string, ic: Parameters<typeof icon>[0], run: () => void, opts: { title?: string; hint?: string } = {}) =>
    h('button', { class: 'rr-drawer__item', title: opts.title, onclick: () => (close(), run()) }, icon(ic, 24), h('span', null, label), opts.hint ? h('small', null, opts.hint) : null);
  const sep = () => h('div', { class: 'rr-drawer__sep', role: 'separator' });
  const open = app.openThreadCount();
  const chapters = app.walkthrough?.chapters.length ?? 0;
  // a segmented button: light, auto (the system's), dark
  const theme = h(
    'div',
    { class: 'rr-seg rr-drawer__theme', role: 'group', 'aria-label': 'Theme' },
    ...(['light', 'system', 'dark'] as const).map((t) =>
      h(
        'button',
        { class: app.prefs.theme === t ? 'is-on' : '', title: { light: 'Light', system: 'Auto: follow the system', dark: 'Dark' }[t], 'aria-label': { light: 'Light', system: 'Auto', dark: 'Dark' }[t], 'aria-pressed': String(app.prefs.theme === t), onclick: (e: Event) => {
          app.setPref('theme', t);
          (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => (b.className = b === e.currentTarget ? 'is-on' : '', b.setAttribute('aria-pressed', String(b === e.currentTarget))));
        } },
        t === 'system' ? 'Auto' : icon(t === 'light' ? 'sun' : 'moon', 16),
      ),
    ),
  );
  const update = updateReady();
  const box = h(
    'dialog',
    { class: 'rr-drawer', 'aria-label': 'Menu', tabindex: '-1', onmousedown: backdropCloses, onclose: () => box.remove() },
    h(
      'header',
      { class: 'rr-drawer__head' },
      h('div', { class: 'rr-drawer__title' }, m.title),
      h('div', { class: 'rr-drawer__facts' }, [m.repo, m.number ? `PR #${m.number}` : null, `Round ${app.state.round}`, `${open} open thread${open === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
    ),
    h(
      'nav',
      { class: 'rr-drawer__list' },
      app.backend.kind === 'server' ? item('All reviews', 'home', () => window.open(hubHref(), '_blank'), { title: 'Every review running on this machine' }) : null,
      item('Search', 'search', () => app.openPalette('')),
      app.walkthrough ? item('Play guided review', 'play', () => app.bus.emit('walkthrough-open', {}), { hint: `${chapters} chapter${chapters === 1 ? '' : 's'}` }) : null,
      sep(),
      ...(app.onGitHub
        ? [
            g?.url ? item('Open PR on GitHub', 'github', () => window.open(g.url, '_blank', 'noopener')) : null,
            item('Refresh comments', 'round', () => void app.refreshGitHub().then(() => app.toast('GitHub comments refreshed'))),
            g?.ok ? h('div', { class: 'rr-drawer__row' }, icon('thread', 24), h('span', null, 'Review'), reviewModeSwitch(app)) : null,
          ]
        : []),
      item('Comment on an element', 'target', () => app.bus.emit('picker', true), { title: 'Pick an element to comment on' }),
      sep(),
      h('div', { class: 'rr-drawer__row' }, icon('theme', 24), h('span', null, 'Theme'), theme),
      canInstall() ? item('Install app', 'install', () => void install(), { title: 'An icon on the home screen, in a window of its own' }) : null,
      update
        ? item(`reviewroom ${__RR_BUILD__.slice(0, 7)}`, 'info', update, { hint: 'Update ready: reload', title: 'Reload into the new version of reviewroom' })
        : h('div', { class: 'rr-drawer__row rr-drawer__version' }, icon('info', 24), h('span', null, `reviewroom ${__RR_BUILD__.slice(0, 7)}`), h('small', null, 'Up to date')),
    ),
  );
  document.body.append(box);
  box.showModal();
  box.focus(); // the drawer, not its first item: no ring or tooltip on open
}

const short = (s: string) => (/^[0-9a-f]{12,}$/.test(s) ? s.slice(0, 7) : s);
