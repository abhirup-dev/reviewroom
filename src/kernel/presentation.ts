// How the workbench is presented, picked once per page load (Refactor 3.0, rr-486). The core reads only this data;
// what a presentation draws (header, panel surface, its seams) is a PresentationModule at the composition root
// (src/presentation.ts for the desktop, src/phone.ts for the phone). Pure: no DOM, so the choice is unit-tested.
import type { Prefs } from '../app';

/** The device's form: a computer or tablet; a phone on its side (the dock, with the phone player); a phone upright
 *  (the phone shell). The screen changing form reloads the page (device.ts watchShell). */
export type Form = 'desktop' | 'turned' | 'phone';

export interface Presentation {
  form: Form;
  /** The panel surface: the dock, or the phone shell. */
  kind: 'dock' | 'phone';
  /** Layouts, windows and docking: the dock's. A phone shows one panel at a time. */
  canArrange: boolean;
  /** The guided walkthrough's player: the phone's on any phone, either way up. */
  phonePlayer: boolean;
  /** A thread opens as a bottom sheet (over the on-screen keyboard), or as a dialog by what it's about. */
  threadPopup: 'sheet' | 'dialog';
  /** Where the prefs live and their defaults: a phone keeps its own (split diffs don't fit it), so trying ?phone
   *  leaves the desktop's alone. */
  prefs: { key: string; defaults: Partial<Prefs> };
}

/** The form for a screen: `small` is a phone (touch, shorter side at most 720px); `forced` is ?phone, the phone
 *  shell on any device. */
export function formFor({ small, landscape, forced }: { small: boolean; landscape: boolean; forced: boolean }): Form {
  if (forced || (small && !landscape)) return 'phone';
  return small ? 'turned' : 'desktop';
}

export function presentationFor(form: Form): Presentation {
  const phone = form === 'phone';
  return {
    form,
    kind: phone ? 'phone' : 'dock',
    canArrange: !phone,
    phonePlayer: form !== 'desktop',
    threadPopup: phone ? 'sheet' : 'dialog',
    prefs: phone ? { key: 'reviewroom:prefs:phone', defaults: { diffStyle: 'unified' } } : { key: 'reviewroom:prefs', defaults: {} },
  };
}
