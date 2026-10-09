// ReviewApp: the shared context every panel, overlay and author element talks to.
// It owns data (meta, files, threads), preferences, navigation and the dock.
import type { DockviewApi } from 'dockview-core';
import { Commands } from '../core/commands';
import { Emitter, loadLocal, saveLocal } from '../core/store';
import { formatRef, parseRef, refLabel, type Ref } from '../core/refs';
import { uid } from '../core/dom';
import { describeElement, findDocElement } from '../core/describe';
import type { Anchor, ChangedFile, Commit, DiffRange, Message, ReviewMeta, ReviewState, SearchHit, Thread } from '../core/types';
import { emptyState } from '../core/types';
import type { CodeProvider, StateBackend } from '../providers';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  diffStyle: 'split' | 'unified';
  ignoreWhitespace: boolean;
  wrap: boolean;
  focus: 'all' | 'additions' | 'deletions';
  fileGroup: 'tree' | 'type' | 'flat';
  hideTests: boolean;
  hiddenTypes: string[];
  inlineThreads: boolean;
  lineDiff: 'word-alt' | 'char' | 'none';
  popoutPlacement: 'right' | 'below' | 'float';
}

export const defaultPrefs: Prefs = {
  theme: 'system',
  diffStyle: 'split',
  ignoreWhitespace: false,
  wrap: false,
  focus: 'all',
  fileGroup: 'tree',
  hideTests: false,
  hiddenTypes: [],
  inlineThreads: true,
  lineDiff: 'word-alt',
  popoutPlacement: 'right',
};

export type CodeTarget = { path: string; side: 'base' | 'head'; start?: number; end?: number; rev?: string; view?: 'diff' | 'file'; panel?: string };
export type Selection =
  | { kind: 'code'; path: string; side: 'base' | 'head'; start: number; end: number; x: number; y: number }
  | { kind: 'doc'; anchor: Extract<Anchor, { kind: 'doc' }>; x: number; y: number; label: string }
  | null;

export interface AppEvents extends Record<string, unknown> {
  state: ReviewState;
  prefs: Prefs;
  files: ChangedFile[];
  range: DiffRange;
  theme: 'light' | 'dark';
  'reveal-code': CodeTarget;
  'reveal-doc': { id: string; path?: string; threadId?: string };
  picker: boolean;
  'open-thread': { id: string; focusComposer?: boolean };
  'compose-thread': { anchor: Anchor; quote?: string };
  selection: Selection;
  'doc-ready': HTMLElement;
  'active-section': string;
  'active-file': string;
  'round-view': number;
  toast: { text: string; kind?: 'info' | 'error' };
}

const isTest = (p: string) => /(^|\/)(__tests__|tests?|spec)(\/)|[._-](test|spec)\.[a-z]+$|_test\.go$/.test(p);
export const fileType = (p: string) => (p.includes('.') ? p.split('.').pop()!.toLowerCase() : 'other');
export const isTestFile = isTest;

export class ReviewApp {
  readonly bus = new Emitter<AppEvents>();
  readonly commands = new Commands();
  meta!: ReviewMeta;
  provider!: CodeProvider;
  backend!: StateBackend;
  state: ReviewState = emptyState();
  prefs: Prefs;
  files: ChangedFile[] = [];
  commits: Commit[] = [];
  range!: DiffRange;
  dock!: DockviewApi;
  /** The narrative root element once mounted (inside the narrative panel). */
  doc: HTMLElement | null = null;
  /** Round being viewed in the narrative (current round unless browsing history). */
  viewRound = 0;
  selection: Selection = null;
  /** Esc handlers for open overlays, newest last; each returns true if it closed something. */
  escapers: (() => boolean)[] = [];
  activeFile = '';
  private cache = new Map<string, Promise<string | null>>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(public root: HTMLElement) {
    this.prefs = loadLocal('readingroom:prefs', defaultPrefs);
  }

  // ------------------------------------------------------------ prefs/theme
  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    this.prefs = { ...this.prefs, [k]: v };
    saveLocal('readingroom:prefs', this.prefs);
    this.bus.emit('prefs', this.prefs);
    if (k === 'theme') this.applyTheme();
  }
  resolvedTheme(): 'light' | 'dark' {
    if (this.prefs.theme !== 'system') return this.prefs.theme;
    const host = document.documentElement.dataset.theme; // embedding host's explicit choice, if any
    if (host === 'light' || host === 'dark') return host;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme() {
    const t = this.resolvedTheme();
    document.documentElement.dataset.rrTheme = t;
    document.documentElement.style.colorScheme = t;
    this.bus.emit('theme', t);
  }

  // ------------------------------------------------------------ code data
  revFor(side: 'base' | 'head', range = this.range) {
    return side === 'base' ? range.base : range.head;
  }
  /** A ref's rev ('base' | 'head' | sha) as a concrete revision. */
  revOf(rev: string) {
    return rev === 'base' || rev === 'head' ? this.revFor(rev) : rev;
  }
  read(path: string, rev: string): Promise<string | null> {
    const key = rev + ':' + path;
    let p = this.cache.get(key);
    if (!p) {
      p = this.provider.read(path, rev).catch((e) => {
        console.warn(e);
        return null;
      });
      this.cache.set(key, p);
    }
    return p;
  }
  async setRange(r: DiffRange) {
    this.range = r;
    this.files = await this.provider.files(r);
    this.bus.emit('range', r);
    this.bus.emit('files', this.files);
  }
  ranges(): DiffRange[] {
    const all: DiffRange = { base: this.meta.base, head: this.meta.head, label: 'All changes', key: 'all' };
    return [all, ...this.commits.map((c) => ({ base: c.sha + '^', head: c.sha, label: `${c.short} · ${c.subject}`, key: c.sha }))];
  }
  visibleFiles(): ChangedFile[] {
    return this.files.filter((f) => !(this.prefs.hideTests && isTest(f.path)) && !this.prefs.hiddenTypes.includes(fileType(f.path)));
  }

  async search(q: string, symbol = false): Promise<SearchHit[]> {
    const rev = this.range.head;
    if (this.provider.search) {
      try {
        return await this.provider.search(q, { rev, symbol, limit: 60 });
      } catch (e) {
        console.warn('provider search failed, falling back to changed files', e);
      }
    }
    // Fallback: scan changed files at head.
    const hits: SearchHit[] = [];
    const def = new RegExp(`\\b(func|type|class|def|interface|const|let|var|struct|enum|message|service)\\s+(\\([^)]*\\)\\s*)?${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (const f of this.files) {
      if (f.status === 'deleted') continue;
      const text = await this.read(f.path, rev);
      text?.split('\n').forEach((line, i) => {
        if (!line.includes(q)) return;
        const isDef = def.test(line);
        if (symbol && !isDef && !new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line)) return;
        hits.push({ path: f.path, line: i + 1, text: line.trim(), rev, kind: isDef ? 'definition' : 'reference' });
      });
    }
    return hits.sort((a, b) => (a.kind === 'definition' ? -1 : 0) - (b.kind === 'definition' ? -1 : 0)).slice(0, 80);
  }

  // ------------------------------------------------------------ navigation
  /** Open anything addressable. Accepts an rr: string or a parsed Ref. */
  async open(ref: string | Ref) {
    const r = typeof ref === 'string' ? parseRef(ref) : ref;
    if (!r) return this.toast(`Unknown link: ${ref}`, 'error');
    switch (r.type) {
      case 'doc':
        this.bus.emit('reveal-doc', { id: r.id, path: r.path });
        break;
      case 'code': {
        const side = r.rev === 'base' ? 'base' : 'head';
        const rev = r.rev !== 'base' && r.rev !== 'head' ? r.rev : undefined;
        this.bus.emit('reveal-code', { path: r.path, side, start: r.start, end: r.end, rev, view: 'diff' });
        break;
      }
      case 'file':
        this.bus.emit('reveal-code', { path: r.path, side: r.rev === 'base' ? 'base' : 'head', start: r.start, end: r.end, rev: /^(base|head)$/.test(r.rev) ? undefined : r.rev, view: 'file' });
        break;
      case 'sym':
        return this.findSymbol(r.name);
      case 'thread':
        this.bus.emit('open-thread', { id: r.id });
        break;
      case 'round':
        this.bus.emit('round-view', r.n);
        break;
    }
  }

  async findSymbol(name: string) {
    const hits = await this.search(name, true);
    const defs = hits.filter((h) => h.kind === 'definition');
    const pick = defs.length === 1 ? defs[0] : hits.length === 1 ? hits[0] : null;
    if (pick) {
      const inDiff = this.files.some((f) => f.path === pick.path);
      this.bus.emit('reveal-code', { path: pick.path, side: 'head', start: pick.line, end: pick.line, view: inDiff ? 'diff' : 'file' });
    } else {
      this.commands.run('palette.symbols:' + name);
      (this as any).openPalette?.('#' + name);
    }
    return hits;
  }

  /** Human name for a narrative element (section title, or “Table in Proto & storage”). */
  describeDoc(id: string, path?: string): string {
    const el = this.doc && findDocElement(this.doc, id, path);
    return el ? describeElement(el) : id ? id.replace(/[-_]+/g, ' ') : 'Review';
  }
  docTitle = (id: string): string | undefined => {
    const el = this.doc?.querySelector(`#${CSS.escape(id)}`);
    if (!el) return undefined;
    const hd = el.matches('h1,h2,h3,h4') ? el : el.querySelector('h1,h2,h3,h4');
    return (hd?.textContent || el.getAttribute('data-title') || id).trim();
  };
  label(ref: string) {
    const r = parseRef(ref);
    if (!r) return 'Link';
    if (r.type === 'doc') return this.describeDoc(r.id, r.path);
    if (r.type === 'thread') {
      const t = this.thread(r.id);
      return t ? 'Thread on ' + this.anchorLabel(t.anchor) : 'Thread';
    }
    if (r.type === 'sym') return r.name;
    return refLabel(r, this.docTitle);
  }
  anchorRef(a: Anchor): string | null {
    switch (a.kind) {
      case 'doc':
        return formatRef({ type: 'doc', id: a.target, path: a.path });
      case 'code':
        return formatRef({ type: 'code', path: a.path, rev: a.rev, start: a.start, end: a.end });
      case 'symbol':
        return formatRef({ type: 'sym', name: a.name });
      default:
        return null;
    }
  }
  anchorLabel(a: Anchor): string {
    if (a.kind === 'general') return 'General';
    if (a.kind === 'doc' && a.quote) return `“${a.quote.exact.length > 48 ? a.quote.exact.slice(0, 47) + '…' : a.quote.exact}”`;
    return this.label(this.anchorRef(a)!);
  }

  // ------------------------------------------------------------ threads
  update(mut: (s: ReviewState) => void) {
    mut(this.state);
    this.bus.emit('state', this.state);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.backend.save(this.state).catch((e) => this.toast('Could not save: ' + e.message, 'error')), 150);
  }
  thread(id: string) {
    return this.state.threads.find((t) => t.id === id || t.id.startsWith(id));
  }
  createThread(anchor: Anchor, body: string, author: Message['author'] = 'you'): Thread {
    const t: Thread = {
      id: uid('t_'),
      anchor,
      status: 'open',
      createdRound: this.state.round,
      messages: [{ id: uid('m_'), author, round: this.state.round, body, at: new Date().toISOString() }],
    };
    this.update((s) => s.threads.push(t));
    return t;
  }
  reply(id: string, body: string, author: Message['author'] = 'you') {
    this.update((s) => {
      const t = s.threads.find((x) => x.id === id);
      t?.messages.push({ id: uid('m_'), author, round: s.round, body, at: new Date().toISOString() });
    });
  }
  editMessage(threadId: string, msgId: string, body: string) {
    this.update((s) => {
      const m = s.threads.find((x) => x.id === threadId)?.messages.find((m) => m.id === msgId);
      if (m) m.body = body;
    });
  }
  deleteMessage(threadId: string, msgId: string) {
    this.update((s) => {
      const t = s.threads.find((x) => x.id === threadId);
      if (!t) return;
      t.messages = t.messages.filter((m) => m.id !== msgId);
      if (!t.messages.length) s.threads = s.threads.filter((x) => x !== t);
    });
  }
  setStatus(id: string, status: Thread['status']) {
    this.update((s) => {
      const t = s.threads.find((x) => x.id === id);
      if (t) t.status = status;
    });
  }
  togglePin(ref: string) {
    this.update((s) => {
      s.pins = s.pins.includes(ref) ? s.pins.filter((p) => p !== ref) : [...s.pins, ref];
    });
  }
  setViewed(path: string, v: boolean) {
    this.update((s) => {
      if (v) s.viewed[path] = s.round;
      else delete s.viewed[path];
    });
  }
  /** Threads with reviewer messages added in the current round (what "Send feedback" will deliver). */
  pendingFeedback() {
    return this.state.threads.filter((t) => t.messages.some((m) => m.author === 'you' && m.round === this.state.round));
  }
  unreadAgent(t: Thread) {
    const last = t.messages[t.messages.length - 1];
    return last?.author === 'agent' && last.round === this.state.round;
  }

  compose(anchor: Anchor, quote?: string) {
    this.bus.emit('compose-thread', { anchor, quote });
  }

  // ------------------------------------------------------------ misc
  toast(text: string, kind: 'info' | 'error' = 'info') {
    this.bus.emit('toast', { text, kind });
  }
  showPanel(id: string) {
    const p = this.dock?.getPanel(id);
    if (p) {
      p.api.setActive();
      return true;
    }
    return false;
  }
}
