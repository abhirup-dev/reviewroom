// A stack of PRs in the header: the PR switcher and the walkthrough's "this PR or the whole stack" menu.
import { h, icon } from './kernel/dom';
import { keyLabel } from './kernel/commands';
import { popMenu, menuItem, menuLabel } from './kernel/menus';
import type { ReviewApp } from './app';

const STATE_LABEL = { merged: 'merged', closed: 'closed', approved: 'approved', changes: 'changes requested', open: 'open' } as const;
const dot = (state: string) => h('span', { class: `rr-stack-dot is-${state}`, 'aria-hidden': 'true' });

/** The stack, in the header's empty middle: which PR the panes show, and how many sit below and above it.
 *  One pip per PR, bottom first, coloured by its state; click for the full list. */
export function stackControl(app: ReviewApp) {
  const s = app.meta.stack!;
  const i = s.findIndex((p) => p.number === app.range?.pr);
  const pips = h('span', { class: 'rr-stack-pips', 'aria-hidden': 'true' }, ...s.map((p, k) => h('span', { class: `rr-stack-pip is-${p.state}` + (k === i ? ' is-on' : '') + (i >= 0 && k !== i ? ' is-off' : '') })));
  const below = i, above = s.length - i - 1;
  const count = (n: number, where: string) => h('span', { class: 'rr-stack-ctl__count' + (n ? '' : ' is-zero'), title: `${n} PR${n === 1 ? '' : 's'} ${where}` }, String(n));
  const where = i < 0 ? `all ${s.length} PRs as one diff (${app.meta.baseLabel ?? 'base'} ← #${s.at(-1)!.number})` : `#${s[i].number}'s changes only (${i ? `#${s[i - 1].number}` : (app.meta.baseLabel ?? 'base')} ← #${s[i].number}): ${below} below, ${above} above`;
  const btn = h(
    'button',
    { class: 'rr-hbtn rr-stack-ctl', 'aria-haspopup': 'menu', 'aria-label': `Stack: ${where}`, title: `Stack: ${where}. Click for every PR (${keyLabel('shift+n')} / ${keyLabel('shift+p')}: next / previous)` },
    icon('stack', 14),
    ...(i < 0 ? [h('strong', null, 'All'), pips, h('span', { class: 'rr-stack-ctl__count' }, String(s.length))] : [h('strong', { class: 'rr-stack-ctl__n' }, `#${s[i].number}`), count(below, 'below'), pips, count(above, 'above')]),
    icon('chevronDown', 12),
  );
  btn.onclick = () => stackMenu(app, btn);
  return btn;
}

function stackMenu(app: ReviewApp, anchor: HTMLElement) {
  const s = app.meta.stack!;
  const chapters = (n: number) => app.walkthrough?.chapters.filter((c) => c.pr === n).length ?? 0;
  const open = (n: number) => app.services.threads.threads().filter((t) => t.status === 'open' && !t.gh?.conversation && app.services.threads.prOf(t) === n).length;
  // the verdicts sent last, per PR
  const sent = app.state.rounds.findLast((r) => r.verdicts)?.verdicts ?? {};
  const said = { approve: 'you approved', changes: 'you asked for changes', comment: 'you commented' } as const;
  const row = (p: (typeof s)[number]) =>
    menuItem(
      h('span', { class: 'rr-stack-row' }, dot(p.state), h('span', { class: 'rr-stack-row__n' }, `#${p.number}`), h('span', { class: 'rr-stack-row__t' }, p.title)),
      () => app.setRange(app.services.code.prRange(p.number)!),
      { checked: p.number === app.range?.pr, hint: `+${p.additions} -${p.deletions} · ${STATE_LABEL[p.state]}${open(p.number) ? ` · ${open(p.number)} open` : ''}${sent[p.number] ? ` · ${said[sent[p.number]]}` : ''}${app.github?.prs?.[p.number]?.stale ? ' · updated on GitHub' : ''}${p.restack ? ' · restacked' : ''}${chapters(p.number) ? ' · ▷' : ''}` },
    );
  popMenu(anchor, (close) => [
    menuLabel(`Stack · ${s.length} PRs, bottom to top`),
    menuItem(h('span', { class: 'rr-stack-row' }, h('span', { class: 'rr-stack-row__n' }, '⇶'), h('span', { class: 'rr-stack-row__t' }, 'Whole stack')), () => (close(), app.setRange(app.services.code.ranges()[0])), { checked: !app.range?.pr, hint: `+${s.reduce((a, p) => a + p.additions, 0)} -${s.reduce((a, p) => a + p.deletions, 0)}` }),
    ...s.map((p) => {
      const b = row(p);
      b.addEventListener('click', close);
      return b;
    }),
    h('div', { class: 'rr-menu__note' }, `${keyLabel('shift+n')} / ${keyLabel('shift+p')}: next / previous PR · ▷ has a guided walkthrough`),
  ]);
}

/** With a stack the Guided walkthrough button asks which story: this PR's chapters, or the whole stack's. */
export function walkthroughMenu(app: ReviewApp, anchor: HTMLElement) {
  const p = app.stackPr;
  const doc = app.walkthrough!;
  const mine = p && doc.chapters.some((c) => c.pr === p.number) ? doc.chapters.filter((c) => !c.pr || c.pr === p.number) : [];
  const slides = (cs: typeof doc.chapters) => cs.reduce((a, c) => a + c.steps.length, 0);
  popMenu(anchor, (close) => [
    menuLabel('Guided walkthrough'),
    p
      ? mine.length
        ? menuItem(`This PR · #${p.number}`, () => (close(), app.bus.emit('walkthrough-open', { scope: 'pr' })), { icon: 'play', hint: `${mine.length} ch · ${slides(mine)} slides` })
        : h('div', { class: 'rr-menu__note' }, `#${p.number} has no walkthrough yet`)
      : null,
    menuItem(`Whole stack · ${app.meta.stack!.length} PRs`, () => (close(), app.bus.emit('walkthrough-open', { scope: 'stack' })), { icon: 'split', hint: `${doc.chapters.length} ch${p ? ` · resumes at #${p.number}` : ''}` }),
  ]);
}
