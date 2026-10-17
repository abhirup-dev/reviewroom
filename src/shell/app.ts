// ReviewApp: the shared context every panel, overlay and author element talks to.
// It owns data (meta, files, threads), preferences, navigation and the dock.
import type { Layout } from '../shared/layout';
import type { DockviewApi } from 'dockview';
import { Commands } from '../core/commands';
import { Emitter, loadLocal, saveLocal } from '../core/store';
import { parseRef, refLabel, type Ref } from '../core/refs';
import { anchorRef } from '../shared/refs';
import { h, uid } from '../core/dom';
import { renderMarkdown } from '../core/markdown';
import { PR_DESCRIPTION } from '../shared/feedback';
import { describeElement, findDocElement } from '../core/describe';
import type { Anchor, Author, ChangedFile, Commit, DiffRange, GitHubSnapshot, Op, ReviewMeta, ReviewState, SearchHit, Thread } from '../core/types';
import { applyOp } from '../shared/ops';
import { emptyState } from '../core/types';
import type { CodeProvider, StateBackend } from '../providers';
import type { GitHubAction } from '../shared/schema';
import { showPanel } from './layout';

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
  /** Which send buttons new code and general comments offer on a GitHub PR: the agent, GitHub, or both. */
  /** Agent: comments to the agent, agent threads listed. Team: code/PR comments to GitHub, GitHub threads listed. All: comments to the agent, every thread listed. */
  reviewMode: 'agent' | 'team' | 'all';
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
  reviewMode: 'agent',
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
  'compose-thread': { anchor: Anchor; quote?: string; to?: 'agent' | 'github' };
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
/** Reading order: the change itself first, then its tests; alphabetical within each. */
export const reviewOrder = (a: { path: string }, b: { path: string }) => Number(isTest(a.path)) - Number(isTest(b.path)) || a.path.localeCompare(b.path);

export class ReviewApp {
  readonly bus = new Emitter<AppEvents>();
  readonly commands = new Commands();
  meta!: ReviewMeta;
  provider!: CodeProvider;
  backend!: StateBackend;
  /** The reviewer's layout files by name (`default` is their default), beside the built-in ones. */
  layouts: Record<string, Layout> = {};
  state: ReviewState = emptyState();
  /** The PR's GitHub threads, when the review is a GitHub PR and the server can reach it. */
  github: GitHubSnapshot | null = null;
  prefs: Prefs;
  files: ChangedFile[] = [];
  commits: Commit[] = [];
  range!: DiffRange;
  dock!: DockviewApi;
  /** The narrative root element once mounted (inside the narrative panel). */
  doc: HTMLElement | null = null;
  /** The PR's description from GitHub: read-only, but commentable like the narrative (anchors target PR_DESCRIPTION). */
  descDoc: HTMLElement = h('div', { id: PR_DESCRIPTION, class: 'rr-prose rr-doc' }, h('p', { class: 'rr-muted' }, 'Loading…'));
  private descKey?: string;
  /** Round being viewed in the narrative (current round unless browsing history). */
  viewRound = 0;
  selection: Selection = null;
  /** Esc handlers for open overlays, newest last; each returns true if it closed something. */
  escapers: (() => boolean)[] = [];
  activeFile = '';
  /** Set when the palette overlay mounts. */
  openPalette!: (initial?: string) => void;
  pickRef!: () => Promise<string | null>;
  private cache = new Map<string, Promise<string | null>>();

  constructor(public root: HTMLElement) {
    this.prefs = loadLocal('reviewroom:prefs', defaultPrefs);
  }

  // ------------------------------------------------------------ prefs/theme
  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    this.prefs = { ...this.prefs, [k]: v };
    saveLocal('reviewroom:prefs', this.prefs);
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
    this.files = (await this.provider.files(r)).sort(reviewOrder);
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
    if (!r) return this.toast(`Unknown link: ${ref as string}`, 'error'); // a Ref always resolves
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
      this.openPalette?.('#' + name);
    }
    return hits;
  }

  /** Human name for a narrative element (section title, or "Table in Proto & storage"). */
  describeDoc(id: string, path?: string): string {
    const el = this.docElement(id, path);
    if (id === PR_DESCRIPTION) return path && el ? describeElement(el) + ' in the PR description' : 'PR description';
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
  anchorLabel(a: Anchor): string {
    if (a.kind === 'general') return 'General';
    if (a.kind === 'doc' && a.quote) return `“${a.quote.exact.length > 48 ? a.quote.exact.slice(0, 47) + '…' : a.quote.exact}”`;
    return this.label(anchorRef(a)!);
  }

  // ------------------------------------------------------------ threads
  /** The one way to change review state: apply locally, show it, hand it to the backend to store. */
  apply(op: Op): boolean {
    try {
      this.state = applyOp(this.state, op);
    } catch (e) {
      this.toast('Could not change that: ' + (e as Error).message, 'error');
      return false;
    }
    this.bus.emit('state', this.state);
    this.backend.apply(op, this.state);
    return true;
  }
  /** Every thread: the review's own (state.json) and the PR's GitHub threads. */
  threads(): Thread[] {
    return this.github?.threads.length ? [...this.state.threads, ...this.github.threads] : this.state.threads;
  }
  thread(id: string) {
    return this.threads().find((t) => t.id === id) ?? this.state.threads.find((t) => t.id.startsWith(id));
  }
  /** Team mode: new code and general comments go to GitHub by default instead of the agent. */
  get teamMode() {
    return this.prefs.reviewMode === 'team' && !!this.github?.ok;
  }
  /** Where a new comment on this anchor goes by default. Narrative comments always go to the agent. */
  commentsToGitHub(anchor: Anchor) {
    return this.teamMode && (anchor.kind === 'code' || anchor.kind === 'general');
  }
  /** The send buttons a new comment on this anchor offers, the same everywhere one starts: Agent, plus PR for code
   *  and general comments; the review mode (or there being no GitHub PR) greys out (`off`, saying why) the side it leaves out. */
  commentTargets(anchor: Anchor): { to: 'agent' | 'github'; label: string; title: string; off?: string }[] {
    const pr = anchor.kind === 'code' || anchor.kind === 'general';
    const gh = !!this.github?.ok;
    const mode = gh ? this.prefs.reviewMode : 'agent';
    const agent = {
      to: 'agent' as const,
      label: 'Agent',
      title: 'A thread for the agent to answer this round',
      off: pr && mode === 'team' ? 'Unavailable in Team review mode. Switch to Agent or All to comment for the agent' : undefined,
    };
    if (!pr) return [agent];
    return [
      agent,
      {
        to: 'github',
        label: 'PR',
        title: anchor.kind === 'code' ? 'A comment in your GitHub review, posted when you submit it' : 'A comment in the PR conversation on GitHub',
        off: !gh ? 'Unavailable: this review is not of a GitHub pull request' : mode === 'agent' ? 'Unavailable in Agent review mode. Switch to Team or All to comment on the PR' : undefined,
      },
    ];
  }
  setGitHub(s: GitHubSnapshot) {
    const failed = s.error && s.error !== this.github?.error;
    this.github = s;
    this.renderDescription();
    if (failed && s.ok) this.toast('GitHub: ' + s.error, 'error');
    this.bus.emit('state', this.state);
  }
  private renderDescription() {
    const d = this.github?.description;
    // only on change: rebuilding drops the reader's open <details> and moves highlights
    const key = d ? d.body + d.at : String(this.github?.ok);
    if (key === this.descKey) return;
    this.descKey = key;
    this.descDoc.innerHTML = d ? renderMarkdown(d.body.trim() || '_No description._') : '<p class="rr-muted">The description shows for GitHub pull requests.</p>';
    // ids from the author's HTML would collide with the narrative's anchors
    this.descDoc.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  }
  /** The element a doc anchor points at, in the narrative or the PR description. */
  docElement(id: string, path?: string): Element | null {
    if (id === PR_DESCRIPTION) return findDocElement(this.descDoc, '', path);
    return this.doc && findDocElement(this.doc, id, path);
  }
  async refreshGitHub() {
    if (this.backend.github) this.setGitHub(await this.backend.github(true));
  }
  /** The thread holding the comment a github.com link on this PR points at (`#discussion_r<n>`, `files#r<n>`, `#issuecomment-<n>`). */
  githubThreadFor(href: string): string | undefined {
    const pr = this.github?.url;
    if (!pr || !href.toLowerCase().startsWith(pr.toLowerCase())) return;
    const m = href.slice(pr.length).match(/^(?:\/[^#]*)?#(?:discussion_r|r|issuecomment-|pullrequestreview-)(\d+)$/);
    return m ? this.github!.threads.find((t) => t.messages.some((x) => x.id === 'gh_' + m[1]))?.id : undefined;
  }
  /** One GitHub action (see cli/lib/github.ts); false (with a toast) if GitHub refused it. */
  async githubAct(action: GitHubAction): Promise<boolean> {
    try {
      this.setGitHub(await this.backend.githubAct!(action));
      return true;
    } catch (e) {
      this.toast('GitHub: ' + (e as Error).message, 'error');
      return false;
    }
  }

  /** Local threads change at once; GitHub ones resolve once GitHub has taken the comment (undefined thread). */
  createThread(anchor: Anchor, body: string, author: Author = 'you', toGitHub = this.commentsToGitHub(anchor)): Thread | undefined | Promise<boolean> {
    if (author === 'you' && toGitHub)
      return anchor.kind === 'code' ? this.githubAct({ action: 'comment', anchor, body }) : this.githubAct({ action: 'conversation', body });
    const id = uid('t_');
    this.apply({ op: 'createThread', id, anchor, msgId: uid('m_'), body, author, at: new Date().toISOString() });
    return this.thread(id);
  }
  reply(threadId: string, body: string, author: Author = 'you') {
    const t = this.thread(threadId);
    if (t?.gh) return this.githubAct(t.gh.conversation ? { action: 'conversation', body } : { action: 'reply', thread: t.id, body });
    this.apply({ op: 'addMessage', threadId, id: uid('m_'), body, author, at: new Date().toISOString() });
  }
  editMessage(threadId: string, msgId: string, body: string) {
    if (threadId.startsWith('gh_')) return this.githubAct({ action: 'edit', message: msgId, body });
    this.apply({ op: 'editMessage', threadId, msgId, body });
  }
  /** Deleting the last message deletes the thread (the UI confirms that first). */
  deleteMessage(threadId: string, msgId: string) {
    if (threadId.startsWith('gh_')) return this.githubAct({ action: 'delete', message: msgId });
    this.apply({ op: 'deleteMessage', threadId, msgId });
  }
  setStatus(threadId: string, status: Thread['status']) {
    if (threadId.startsWith('gh_')) return this.githubAct({ action: 'resolve', thread: threadId, resolved: status === 'resolved' });
    this.apply({ op: 'setThreadStatus', threadId, status });
  }
  togglePin(ref: string) {
    this.apply({ op: 'setPin', ref, pinned: !this.state.pins.includes(ref) });
  }
  setViewed(path: string, viewed: boolean) {
    this.apply({ op: 'setViewed', path, viewed });
  }
  /** Threads with reviewer messages added in the current round (what "Send feedback" will deliver). */
  pendingFeedback() {
    return this.state.threads.filter((t) => t.messages.some((m) => m.author === 'you' && m.round === this.state.round));
  }
  unreadAgent(t: Thread) {
    const last = t.messages[t.messages.length - 1];
    return last?.author === 'agent' && last.round === this.state.round;
  }

  /** `to`: the send button ⌘↵ uses, when the comment can go to the agent or GitHub. */
  compose(anchor: Anchor, quote?: string, to?: 'agent' | 'github') {
    this.bus.emit('compose-thread', { anchor, quote, to });
  }

  // ------------------------------------------------------------ misc
  toast(text: string, kind: 'info' | 'error' = 'info') {
    this.bus.emit('toast', { text, kind });
  }
  showPanel(id: string) {
    return showPanel(this, id);
  }
}
