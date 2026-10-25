// Desktop: the Guided walkthrough button's menu on a stack: this PR's story, or the whole stack's.
import { h } from '../kernel/dom';
import { popMenu, menuItem, menuLabel } from '../kernel/menus';
import type { ReviewApp } from '../app';

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
