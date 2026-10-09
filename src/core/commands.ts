// One registry drives the command palette, keyboard shortcuts and menus.
// Agents can add commands from their own scripts via rr.commands.register().

export interface Command {
  id: string;
  title: string;
  group?: string;
  /** e.g. 'mod+k', 'shift+?', 'g d', 'j'. 'mod' = ⌘ on mac, Ctrl elsewhere. */
  keys?: string[];
  /** Restrict shortcut to a scope: 'code' when focus is in a code panel, 'global' otherwise. */
  scope?: 'global' | 'code' | 'narrative';
  hint?: string;
  run: () => void;
  when?: () => boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modLabel = isMac ? '⌘' : 'Ctrl';

export function keyLabel(k: string) {
  return k
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((p) => ({ mod: modLabel, shift: '⇧', alt: isMac ? '⌥' : 'Alt', enter: '↵', escape: 'Esc' }[p] ?? p.toUpperCase()))
        .join(isMac ? '' : '+'),
    )
    .join(' ');
}

export class Commands {
  private list = new Map<string, Command>();
  private pending = '';
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  scopeOf: (target: EventTarget | null) => 'global' | 'code' | 'narrative' = () => 'global';

  register(...cmds: Command[]) {
    for (const c of cmds) this.list.set(c.id, c);
    return () => cmds.forEach((c) => this.list.delete(c.id));
  }
  get(id: string) {
    return this.list.get(id);
  }
  run(id: string) {
    const c = this.list.get(id);
    if (c && (!c.when || c.when())) c.run();
  }
  all() {
    return [...this.list.values()].filter((c) => !c.when || c.when());
  }

  attach(root: Document | HTMLElement = document) {
    root.addEventListener('keydown', (ev) => this.onKey(ev as KeyboardEvent), true);
  }

  private onKey(ev: KeyboardEvent) {
    const t = ev.composedPath()[0] as HTMLElement | undefined;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    let k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
    if (k === ' ') k = 'space';
    const shift = ev.shiftKey && (ev.key.length > 1 || /^[a-z]$/i.test(ev.key));
    if (ev.altKey && /^Digit\d$/.test(ev.code)) k = ev.code.slice(5);
    const chord = [mod && 'mod', shift && 'shift', ev.altKey && 'alt', k].filter(Boolean).join('+');
    if (typing && !mod) return;
    const scope = this.scopeOf(t ?? null);
    const seq = this.pending ? this.pending + ' ' + chord : chord;
    let partial = false;
    for (const c of this.list.values()) {
      if (!c.keys || (c.when && !c.when())) continue;
      if (c.scope && c.scope !== 'global' && c.scope !== scope) continue;
      for (const key of c.keys) {
        if (key === seq) {
          ev.preventDefault();
          ev.stopPropagation();
          this.pending = '';
          c.run();
          return;
        }
        if (key.startsWith(seq + ' ')) partial = true;
      }
    }
    if (partial) {
      this.pending = seq;
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => (this.pending = ''), 900);
      ev.preventDefault();
    } else this.pending = '';
  }
}
