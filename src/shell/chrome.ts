// Top bar: identity, rounds, search, picker, layout, theme, send feedback.
import { h, icon, copyText, relTime, placeNear, backdropCloses } from '../core/dom';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
import { keyLabel, modLabel } from '../core/commands';
import { feedbackMarkdown } from '../shared/feedback';
import { applyLayout, canUndoLayout, closePanel, deleteLayout, ensurePanel, hasPanel, layouts, panelDefs, resetLayout, saveLayout, setDefaultLayout, undoLayout } from './layout';
import type { ReviewApp } from './app';
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
      await copyText(feedbackMarkdown(app.state, { kind, note: text }));
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
  if (!g || (!g.ok && !g.threads?.length && /not a GitHub/.test(g.error ?? ''))) return [];
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
  if (!g.ok) return [btn];
  const seg = h(
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
  return [btn, seg];
}

// ---------------------------------------------------------------- header
export function buildHeader(app: ReviewApp): HTMLElement {
  const m = app.meta;
  const bar = h('header', { class: 'rr-header' });
  const paint = () => {
    const pending = app.pendingFeedback().length;
    const round = app.state.rounds.find((r) => r.n === app.state.round);
    const themeIcon = app.resolvedTheme() === 'dark' ? 'moon' : 'sun';
    const roundBtn = h('button', { class: 'rr-hbtn', 'aria-haspopup': 'menu', title: 'Review rounds: view the narrative as it was at the end of an earlier round' }, icon('round', 14), h('span', null, `Round ${app.state.round}`), icon('chevronDown', 12));
    roundBtn.onclick = () =>
      popMenu(roundBtn, (close) => [
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
        h('span', { class: 'rr-round-status rr-round-status--waiting', title: 'Your feedback went to the agent. The next round opens here when it is back' }, 'Waiting for the agent…'),
        h('span', { class: 'rr-pill rr-pill--ok rr-round-status rr-round-status--approved', title: 'You approved this review; the reviewroom server has stopped' }, 'Approved'),
        h('span', { class: 'rr-pill rr-pill--draft rr-round-status rr-round-status--offline', title: 'The reviewroom server stopped. Changes stay in this tab and are saved when it is back' }, 'Disconnected'),
        h('span', { class: 'rr-pill rr-pill--draft rr-unsaved', title: 'The reviewroom server has not stored your latest changes. Reviewroom keeps retrying; keep this tab open' }, 'Not saved yet'),
        app.backend.kind === 'server' ? h('a', { class: 'rr-hbtn', href: '/api/hub', target: '_blank', title: 'Every review running on this machine: reviewroom, Crit and Plannotator' }, 'All reviews') : null,
        h('button', { class: 'rr-search-btn', onclick: () => app.openPalette(''), title: 'Jump to a file, section, thread or command. Type # for symbols, / to search code', 'data-keys': 'mod+k' }, icon('search', 14), h('span', null, 'Jump to…'), h('kbd', null, `${modLabel}K`)),
        ...githubControls(app),
        app.teamMode ? null : roundBtn,
        h('button', { class: 'rr-hbtn rr-hbtn--icon' + (app.root.classList.contains('is-picking') ? ' is-on' : ''), title: 'Pick any element in the narrative to comment on (or hold Alt while hovering)', 'data-keys': 'x', 'aria-label': 'Pick element to comment', onclick: () => app.bus.emit('picker', !app.root.classList.contains('is-picking')) }, icon('target', 16)),
        layoutBtn,
        h('button', { class: 'rr-hbtn rr-hbtn--icon', title: `Theme: ${app.prefs.theme === 'system' ? 'follows your system' : app.prefs.theme}. Click to switch`, 'aria-label': 'Toggle theme', onclick: () => app.setPref('theme', app.prefs.theme === 'system' ? (app.resolvedTheme() === 'dark' ? 'light' : 'dark') : app.prefs.theme === 'dark' ? 'light' : 'system') }, icon(themeIcon, 16)),
        app.teamMode
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
        ),
      ),
    );
  };
  app.bus.on('state', paint);
  app.bus.on('prefs', paint);
  app.bus.on('theme', paint);
  app.bus.on('files', paint);
  app.bus.on('picker', (on) => {
    app.root.classList.toggle('is-picking', on);
    paint();
  });
  app.bus.on('round-view', () => setTimeout(paint));
  paint();
  return bar;
}

const short = (s: string) => (/^[0-9a-f]{12,}$/.test(s) ? s.slice(0, 7) : s);
