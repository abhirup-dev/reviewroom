// The guided walkthrough player on a desktop (and a tablet): the chapter button opens a menu, Next is a labelled button.
import { h, icon, plural } from '../kernel/dom';
import { errorText } from '../kernel/errors.shared';
import { menuItem, popMenu } from '../kernel/menus';
import type { current } from './model.shared';
import type { PlayerParts } from './player';

export function desktopPlayer(parts: PlayerParts) {
  const { app, player, reset, close } = parts;
  const title = 'Download this walkthrough as a standalone HTML file';
  const getExport = app.backend.downloadWalkthrough?.bind(app.backend);
  const download = getExport && h('button', {
    class: 'rr-icon-btn', title, 'aria-label': title, onclick: async () => {
      if (!download) return;
      download.disabled = true;
      try {
        const { file, filename } = await getExport();
        if (!download.isConnected) return;
        const href = URL.createObjectURL(file);
        const link = h('a', { href, download: filename });
        link.click();
        // Give the browser time to start consuming the object URL.
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      } catch (e) {
        if (download.isConnected) app.toast(`Could not download walkthrough: ${errorText(e)}`, 'error');
      } finally {
        download.disabled = false;
      }
    },
  }, icon('download', 14));
  player.prepend(h('div', { class: 'rr-tour__top' }, reset, download, close));
  return desktopNavigation(parts);
}

export function desktopNavigation({ actor, root, chapterBtn, next }: Pick<PlayerParts, 'actor' | 'root' | 'chapterBtn' | 'next'>) {
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
      next.title = isLast ? 'End the walkthrough' : 'Next slide';
      next.replaceChildren(isLast ? 'Finish' : 'Next', isLast ? icon('check', 14) : icon('chevron', 14));
    },
  };
}
