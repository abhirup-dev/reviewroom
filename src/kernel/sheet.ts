// M3 bottom sheets: a kept <dialog class="rr-modal rr-sheet"> on <body>, refilled each time it opens. Its backdrop
// closes it; on a phone Back does too (PhoneShell watches open dialogs); phone.css raises it, and kept, it can slide away.
import { backdropCloses, h, type Attrs } from './dom';

/** The dialog, appended to <body>; `sheet: false` keeps it a centred modal (the same dialog on a desktop). */
export function sheetDialog(attrs: Attrs, sheet = true) {
  const box = h('dialog', { ...attrs, class: 'rr-modal' + (sheet ? ' rr-sheet' : '') + (attrs.class ? ` ${attrs.class}` : ''), onmousedown: backdropCloses });
  document.body.append(box);
  return box;
}

/** Show `content` in it, opening it if it's closed. */
export function openSheet(box: HTMLDialogElement, ...content: Node[]) {
  box.replaceChildren(...content);
  if (!box.open) box.showModal();
}
