// Top bar: identity, rounds, search, picker, layout, theme, send feedback.
import { h, icon, copyText } from '../core/dom';
import { keyLabel, modLabel } from '../core/commands';
import { feedbackMarkdown } from '../../cli/lib/feedback.mjs';
import { applyPreset, ensurePanel, panelDefs, presets } from './layout';
import type { ReviewApp } from './app';

// ---------------------------------------------------------------- tiny menu
export function popMenu(anchor: HTMLElement, build: (close: () => void) => (HTMLElement | null)[]) {
  document.querySelectorAll('.rr-menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'rr-menu', role: 'menu' });
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
  };
  const outside = (e: Event) => !menu.contains(e.target as Node) && !anchor.contains(e.target as Node) && close();
  menu.append(...(build(close).filter(Boolean) as HTMLElement[]));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  Object.assign(menu.style, { top: r.bottom + 6 + 'px', left: Math.max(8, Math.min(window.innerWidth - m.width - 8, r.right - m.width)) + 'px' });
  anchor.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  menu.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  (menu.querySelector('button') as HTMLElement | null)?.focus();
  return close;
}
export const menuItem = (label: string | Node, fn: () => void, opts: { hint?: string; checked?: boolean; icon?: Parameters<typeof icon>[0] } = {}) =>
  h('button', { class: 'rr-menu__item', role: 'menuitem', onclick: fn }, h('span', { class: 'rr-menu__check' }, opts.checked ? icon('check', 12) : opts.icon ? icon(opts.icon, 14) : ''), h('span', { class: 'rr-menu__label' }, label), opts.hint ? h('span', { class: 'rr-menu__hint' }, opts.hint) : null);
export const menuLabel = (t: string) => h('div', { class: 'rr-menu__label-row' }, t);

// ---------------------------------------------------------------- send dialog
export function sendDialog(app: ReviewApp) {
  const pending = app.pendingFeedback();
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Overall note for the agent (optional, markdown)' }) as HTMLTextAreaElement;
  const scrim = h('div', { class: 'rr-scrim' });
  const esc = () => (close(), true);
  const close = () => {
    scrim.remove();
    app.escapers = app.escapers.filter((f) => f !== esc);
  };
  app.escapers.push(esc);
  const go = async (kind: 'feedback' | 'approve') => {
    if (app.backend.finish) {
      const res = await app.backend.finish(kind, note.value.trim() || undefined).catch((e) => ({ ok: false, message: String(e) }));
      close();
      app.toast(res.ok ? (kind === 'approve' ? 'Approved. The agent has been told.' : `Round ${app.state.round - (kind === 'feedback' ? 0 : 0)} sent — the agent is working on the next round.`) : 'Failed: ' + (res.message ?? 'unknown'), res.ok ? 'info' : 'error');
      if (res.ok) app.root.classList.add('is-waiting');
    } else {
      const md = feedbackMarkdown(app.state, { kind, note: note.value.trim() || undefined });
      await copyText(md);
      app.update((s) => {
        const r = s.rounds.find((x) => x.n === s.round);
        if (r) Object.assign(r, { status: kind === 'approve' ? 'approved' : 'sent', sentAt: new Date().toISOString(), note: note.value.trim() || undefined });
        if (kind === 'feedback') {
          s.round += 1;
          s.rounds.push({ n: s.round, status: 'open', startedAt: new Date().toISOString() });
        }
      });
      close();
      app.toast('Feedback copied to the clipboard — paste it to your agent.');
    }
  };
  const box = h(
    'div',
    { class: 'rr-modal rr-modal--narrow', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Finish round' },
    h('header', { class: 'rr-thread__head' }, h('strong', null, `Finish round ${app.state.round}`), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Close', onclick: close }, icon('close', 14))),
    h(
      'div',
      { class: 'rr-send__body' },
      h('p', { class: 'rr-muted' }, pending.length ? `${pending.length} thread${pending.length > 1 ? 's' : ''} with new comments will be sent:` : 'No new comments this round.'),
      h('ul', { class: 'rr-send__list' }, ...pending.map((t) => h('li', null, h('span', { class: 'rr-chip rr-chip--static' }, app.anchorLabel(t.anchor)), ' ', t.messages.filter((m) => m.author === 'you' && m.round === app.state.round).length + ' comment(s)'))),
      note,
      h('p', { class: 'rr-muted rr-small' }, app.backend.finish ? 'The agent receives this as structured feedback, replies in the threads and updates the review. You’ll see round ' + (app.state.round + 1) + ' here when it’s done.' : 'No local server: the feedback is copied as markdown for you to paste to the agent.'),
    ),
    h('footer', { class: 'rr-composer__foot' }, h('button', { class: 'rr-btn rr-btn--ghost', onclick: () => go('approve') }, icon('check', 12), 'Approve'), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-btn rr-btn--ghost', onclick: close }, 'Cancel'), h('button', { class: 'rr-btn rr-btn--primary', onclick: () => go('feedback') }, icon('send', 12), 'Send feedback')),
  );
  scrim.append(box);
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());
  scrim.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(scrim);
  note.focus();
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
    const layoutBtn = h('button', { class: 'rr-hbtn rr-hbtn--icon', 'aria-label': 'Layout', title: 'Layout presets and which panels are open', 'aria-haspopup': 'menu' }, icon('layout', 16));
    layoutBtn.onclick = () =>
      popMenu(layoutBtn, (close) => [
        menuLabel('Layout presets'),
        ...presets.map((p, i) => menuItem(p.title, () => (close(), applyPreset(app, p.id)), { hint: keyLabel(`alt+${i + 1}`) })),
        menuLabel('Panels'),
        ...panelDefs()
          .filter((d) => !d.onDemand)
          .map((d) => menuItem(d.title, () => (close(), app.dock.getPanel(d.id) ? app.dock.getPanel(d.id)!.api.close() : ensurePanel(app, d.id)), { checked: !!app.dock.getPanel(d.id) })),
        menuLabel('Tip: drag any tab to an edge to split, or onto another group to stack.'),
      ]);
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
            app.commits.length ? h('span', { class: 'rr-pill', title: 'Commits in this PR; pick one in Files to review it alone' }, `${app.commits.length} commit${app.commits.length > 1 ? 's' : ''}`) : null,
            ...(m.tags ?? []).map((t) => h('span', { class: 'rr-pill' }, t)),
            h('span', { class: 'rr-pill rr-pill--src', title: app.provider.name === 'local' ? 'Code is read from your local clone with git (no API limits)' : app.provider.name === 'github' ? 'Code is read from GitHub' : 'Code is embedded in this page' }, app.provider.name === 'local' ? 'local clone' : app.provider.name),
          ),
        ),
      ),
      h('div', { class: 'rr-toolbar__spacer' }),
      h(
        'div',
        { class: 'rr-header__actions' },
        h('button', { class: 'rr-search-btn', onclick: () => (app as any).openPalette(''), title: 'Jump to a file, section, thread or command. Type # for symbols, / to search code', 'data-keys': 'mod+k' }, icon('search', 14), h('span', null, 'Jump to…'), h('kbd', null, `${modLabel}K`)),
        roundBtn,
        h('button', { class: 'rr-hbtn rr-hbtn--icon' + (app.root.classList.contains('is-picking') ? ' is-on' : ''), title: 'Pick any element in the narrative to comment on (or hold Alt while hovering)', 'data-keys': 'x', 'aria-label': 'Pick element to comment', onclick: () => app.bus.emit('picker', !app.root.classList.contains('is-picking')) }, icon('target', 16)),
        layoutBtn,
        h('button', { class: 'rr-hbtn rr-hbtn--icon', title: `Theme: ${app.prefs.theme === 'system' ? 'follows your system' : app.prefs.theme}. Click to switch`, 'aria-label': 'Toggle theme', onclick: () => app.setPref('theme', app.prefs.theme === 'system' ? (app.resolvedTheme() === 'dark' ? 'light' : 'dark') : app.prefs.theme === 'dark' ? 'light' : 'system') }, icon(themeIcon, 16)),
        h(
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
