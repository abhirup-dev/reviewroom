// The guided walkthrough player on a desktop (and a tablet): the chapter button opens a menu, Next is a labelled button.
import type { Actor } from 'xstate';
import { icon, plural } from '../kernel/dom';
import { menuItem, popMenu } from '../kernel/menus';
import type { walkthroughMachine } from './player.machine';
import type { current } from './model.shared';

export function desktopPlayer({ actor, root, chapterBtn, next }: { actor: Actor<typeof walkthroughMachine>; root: HTMLElement; chapterBtn: HTMLElement; next: HTMLElement }) {
  root.dataset.form = 'desktop'; // slides.css: the chapter as the narration's heading, the code full height beside it
  const ctx = () => actor.getSnapshot().context;
  chapterBtn.title = 'Jump to a chapter';
  chapterBtn.setAttribute('aria-haspopup', 'menu');
  return {
    contents: () =>
      popMenu(chapterBtn, (close) =>
        ctx().doc!.chapters.map((c, i) =>
          menuItem(c.title, () => { close(); actor.send({ type: 'goto', chapter: i, step: 0 }); }, { checked: i === ctx().chapter, hint: plural(c.steps.length, 'slide') }),
        ),
      ),
    paintNav: ({ isLast }: ReturnType<typeof current>) => {
      next.title = isLast ? 'End the guided walkthrough' : 'Next slide';
      next.replaceChildren(isLast ? 'Finish' : 'Next', isLast ? icon('check', 14) : icon('chevron', 14));
    },
  };
}
