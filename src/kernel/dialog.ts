// Narrow modal primitive shared by shell and feature dialogs.
import { h, icon, backdropCloses } from './dom';

/** A narrow modal dialog (title, close button, body, footer), removed once closed; `note` gets the focus.
 *  `act` wraps a footer action: one at a time (a double click must not do it twice), closing when it returns true. */
export type Act = (fn: () => Promise<boolean>) => () => Promise<void>;
export function noteDialog(label: string, title: string, note: HTMLElement, content: (act: Act, close: () => void) => [body: (HTMLElement | null)[], foot: HTMLElement[]]) {
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

