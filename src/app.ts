// ReviewApp: the shared context every panel, overlay and author element talks to.
// It owns data (meta, files, threads), preferences, navigation and the dock.
import { Layouts } from './kernel/layouts/layout';
import type { DockviewApi } from 'dockview';
import { Commands } from './kernel/commands';
import { Emitter, loadLocal, saveLocal } from './kernel/store';
import { parseRef, refLabel, type Ref } from './kernel/refs/browser';
import { anchorRef, symbolHits, symbolQuery, PR_DESCRIPTION } from './kernel/refs/refs.shared';
import { h, uid } from './kernel/dom';
import { renderMarkdown } from './kernel/markdown';
import { describeElement, findDocElement } from './kernel/refs/describe';
import { emptyState, type Anchor, type Author, type ChangedFile, type Commit, type DiffRange, type GitHubSnapshot, type Op, type ReviewMeta, type ReviewState, type SearchHit, type Thread } from './kernel/state/model.shared';
import { applyOp } from './kernel/state/ops.shared';
import type { CodeProvider, StateBackend } from './kernel/providers/contracts';
import { createReviewServices, type ReviewServices } from './services';
import type { GitHubAction } from './kernel/state/schema.shared';
import type { Walkthrough } from './slides/model.shared';
import { showPanel } from './kernel/dock';
import type { CodeTarget, Selection } from './review/navigation.shared';
import { fileType, isTestFile, reviewOrder } from './review/files.shared';

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


export interface AppEvents extends Record<string, unknown> {
  state: ReviewState;
  prefs: Prefs;
  files: ChangedFile[];
  range: DiffRange;
  theme: 'light' | 'dark';
  'reveal-code': CodeTarget;
  /** a code panel finished a reveal: its lines are highlighted and on screen (or there was nothing to highlight) */
  'code-landed': { panel: string };
  'reveal-doc': { id: string; path?: string; threadId?: string };
  picker: boolean;
  'open-thread': { id: string; focusComposer?: boolean };
  'compose-thread': { anchor: Anchor; quote?: string; to?: 'agent' | 'github' };
  selection: Selection;
  'doc-ready': HTMLElement;
  'active-section': string;
  'active-file': string;
  'round-view': number;
  /** play the walkthrough at a step (ids; missing: the first) */
  'walkthrough-open': { chapter?: string; step?: string };
  /** walkthrough.json loaded (null: none, or invalid) */
  walkthrough: Walkthrough | null;
  toast: { text: string; kind?: 'info' | 'error' };
}


export class ReviewApp {
  readonly bus = new Emitter<AppEvents>();
  readonly commands = new Commands();
  meta!: ReviewMeta;
  provider!: CodeProvider;
  backend!: StateBackend;
  /** The review's layouts: the saved ones, the default, the one the dock was built from, and the dock's undo. */
  readonly layout = new Layouts(this);
  state: ReviewState = emptyState();
  /** The PR's GitHub threads, when the review is a GitHub PR and the server can reach it. */
  github: GitHubSnapshot | null = null;
  prefs: Prefs;
  files: ChangedFile[] = [];
  commits: Commit[] = [];
  /** walkthrough.json, once loaded and valid; `walkthroughIssues` when it breaks the schema */
  walkthrough: Walkthrough | null = null;
  walkthroughIssues: string[] | null = null;
  range!: DiffRange;
  dock!: DockviewApi;
  /** The walkthrough root element once mounted (inside the walkthrough panel). */
  doc: HTMLElement | null = null;
  /** The PR's description from GitHub: read-only, but commentable like the walkthrough (anchors target PR_DESCRIPTION). */
  descDoc: HTMLElement = h('div', { id: PR_DESCRIPTION, class: 'rr-prose rr-doc' }, h('p', { class: 'rr-muted' }, 'Loading…'));
  private descKey?: string;
  /** Round being viewed in the walkthrough (current round unless browsing history). */
  viewRound = 0;
  selection: Selection = null;
  /** Esc handlers for open overlays, newest last; each returns true if it closed something. */
  escapers: (() => boolean)[] = [];
  activeFile = '';
  /** Set when the palette overlay mounts. */
  openPalette!: (initial?: string) => void;
  pickRef!: () => Promise<string | null>;
  readonly services: ReviewServices;
  private cleanups: (() => void)[] = [];
  private disposed = false;

  onDispose(cleanup: () => void) {
    if (this.disposed) cleanup();
    else this.cleanups.push(cleanup);
  }
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, handler: (event: DocumentEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  listen<K extends keyof WindowEventMap>(target: Window, type: K, handler: (event: WindowEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, handler: EventListener, options?: boolean | AddEventListenerOptions) {
    target.addEventListener(type, handler, options);
    this.onDispose(() => target.removeEventListener(type, handler, options));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    this.dock?.dispose();
    this.backend?.dispose?.();
    this.bus.clear();
  }

  // Keep new ReviewApp(root) compatible; boot supplies its composition explicitly.
  constructor(public root: HTMLElement, createServices = createReviewServices) {
    this.prefs = loadLocal('reviewroom:prefs', defaultPrefs);
    this.services = createServices({
      github: {
        backend: () => this.backend,
        snapshot: () => this.github,
        publish: (snapshot) => {
          this.github = snapshot;
          this.renderDescription();
          this.bus.emit('state', this.state);
        },
        error: (message) => this.toast(message, 'error'),
      },
      code: {
        provider: () => this.provider,
        range: () => this.range,
        meta: () => this.meta,
        commits: () => this.commits,
        files: () => this.files,
      },
      threads: {
        getState: () => this.state,
        getGitHub: () => this.github,
        getReviewMode: () => this.prefs.reviewMode,
        apply: (op) => this.apply(op),
        githubAct: (action) => this.githubAct(action),
        uid,
      },
    });
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
    return this.services.code.revFor(side, range);
  }
  /** A ref's rev ('base' | 'head' | sha) as a concrete revision. */
  revOf(rev: string) {
    return this.services.code.revOf(rev);
  }
  read(path: string, rev: string): Promise<string | null> {
    return this.services.code.read(path, rev);
  }
  async setRange(r: DiffRange) {
    this.range = r;
    this.files = (await this.provider.files(r)).sort(reviewOrder);
    this.bus.emit('range', r);
    this.bus.emit('files', this.files);
  }
  ranges(): DiffRange[] {
    return this.services.code.ranges();
  }
  visibleFiles(): ChangedFile[] {
    return this.files.filter((f) => !(this.prefs.hideTests && isTestFile(f.path)) && !this.prefs.hiddenTypes.includes(fileType(f.path)));
  }

  async search(q: string, symbol = false): Promise<SearchHit[]> {
    return this.services.code.search(q, symbol);
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
        // a path outside the diff has no hunks to show: open the whole file instead
        const view = this.files.some((f) => f.path === r.path) ? 'diff' : 'file';
        this.bus.emit('reveal-code', { path: r.path, side, start: r.start, end: r.end, rev, view });
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
      case 'tour':
        this.bus.emit('walkthrough-open', { chapter: r.chapter, step: r.step });
        break;
    }
  }

  /** Search hits for an `rr:sym` name (`Name`, `Owner.Name`, `path:Name`), definitions first. */
  // shortcut: filters the first 60 hits (definitions come first), so a qualifier can miss when a name has more
  // definitions than that; pass a larger limit through search() if that shows up.
  async searchSymbol(name: string): Promise<SearchHit[]> {
    return symbolHits(await this.search(symbolQuery(name).word, true), name);
  }

  async findSymbol(name: string) {
    const hits = await this.searchSymbol(name);
    const defs = hits.filter((h) => h.kind === 'definition');
    const pick = defs.length === 1 ? defs[0] : hits.length === 1 ? hits[0] : null;
    if (pick) {
      const inDiff = this.files.some((f) => f.path === pick.path);
      this.bus.emit('reveal-code', { path: pick.path, side: 'head', start: pick.line, end: pick.line, view: inDiff ? 'diff' : 'file' });
    } else {
      const word = symbolQuery(name).word;
      this.commands.run('palette.symbols:' + word);
      this.openPalette?.('#' + word);
    }
    return hits;
  }

  /** Human name for a walkthrough element (section title, or "Table in Proto & storage"). */
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
    if (r.type === 'tour') {
      const ch = this.walkthrough?.chapters.find((c) => c.id === r.chapter);
      const n = ch ? ch.steps.findIndex((s) => s.id === r.step) + 1 : 0;
      return ch && n ? `Guided walkthrough · ${ch.title} · slide ${n}` : 'Guided walkthrough slide';
    }
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
    return this.services.threads.threads();
  }
  thread(id: string) {
    return this.services.threads.thread(id);
  }
  /** Team mode: new code and general comments go to GitHub by default instead of the agent. */
  get teamMode() {
    return this.services.threads.teamMode;
  }
  /** Where a new comment on this anchor goes by default. Narrative comments always go to the agent. */
  commentsToGitHub(anchor: Anchor) {
    return this.services.threads.commentsToGitHub(anchor);
  }
  /** The send buttons a new comment on this anchor offers, the same everywhere one starts: Agent, plus PR for code
   *  and general comments; the review mode (or there being no GitHub PR) greys out (`off`, saying why) the side it leaves out. */
  commentTargets(anchor: Anchor): { to: 'agent' | 'github'; label: string; title: string; off?: string }[] {
    return this.services.threads.commentTargets(anchor);
  }
  setGitHub(s: GitHubSnapshot) {
    this.services.github.set(s);
  }
  private renderDescription() {
    const d = this.github?.description;
    // only on change: rebuilding drops the reader's open <details> and moves highlights
    const key = d ? d.body + d.at : String(this.github?.ok);
    if (key === this.descKey) return;
    this.descKey = key;
    this.descDoc.innerHTML = d ? renderMarkdown(d.body.trim() || '_No description._') : '<p class="rr-muted">The description shows for GitHub pull requests.</p>';
    // ids from the author's HTML would collide with the walkthrough's anchors
    this.descDoc.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  }
  /** The element a doc anchor points at, in the walkthrough or the PR description. */
  docElement(id: string, path?: string): Element | null {
    if (id === PR_DESCRIPTION) return findDocElement(this.descDoc, '', path);
    return this.doc && findDocElement(this.doc, id, path);
  }
  async refreshGitHub() {
    await this.services.github.refresh();
  }
  /** The thread holding the comment a github.com link on this PR points at (`#discussion_r<n>`, `files#r<n>`, `#issuecomment-<n>`). */
  githubThreadFor(href: string): string | undefined {
    return this.services.threads.githubThreadFor(href);
  }
  /** One GitHub action (see cli/lib/github.ts); false (with a toast) if GitHub refused it. */
  async githubAct(action: GitHubAction): Promise<boolean> {
    return this.services.github.act(action);
  }

  /** Local threads change at once; GitHub ones resolve once GitHub has taken the comment (undefined thread). */
  createThread(anchor: Anchor, body: string, author: Author = 'you', toGitHub = this.commentsToGitHub(anchor)): Thread | undefined | Promise<boolean> {
    return this.services.threads.createThread(anchor, body, author, toGitHub);
  }
  reply(threadId: string, body: string, author: Author = 'you') {
    return this.services.threads.reply(threadId, body, author);
  }
  editMessage(threadId: string, msgId: string, body: string) {
    return this.services.threads.editMessage(threadId, msgId, body);
  }
  /** Deleting the last message deletes the thread (the UI confirms that first). */
  deleteMessage(threadId: string, msgId: string) {
    return this.services.threads.deleteMessage(threadId, msgId);
  }
  setStatus(threadId: string, status: Thread['status']) {
    return this.services.threads.setStatus(threadId, status);
  }
  togglePin(ref: string) {
    this.apply({ op: 'setPin', ref, pinned: !this.state.pins.includes(ref) });
  }
  setViewed(path: string, viewed: boolean) {
    this.apply({ op: 'setViewed', path, viewed });
  }
  /** Threads with reviewer messages added in the current round (what "Send feedback" will deliver). */
  pendingFeedback() {
    return this.services.threads.pendingFeedback();
  }
  unreadAgent(t: Thread) {
    return this.services.threads.unreadAgent(t);
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
