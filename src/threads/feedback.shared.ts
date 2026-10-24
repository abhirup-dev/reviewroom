// Shared by the CLI and the browser: turn the reviewer's round into a prompt the
// agent can act on. No DOM or Node imports, so both the client bundle and the CLI can import it.
import type { Message, ReviewState, Thread } from '../kernel/state/model.shared';
import { anchorRef, PR_DESCRIPTION } from '../kernel/refs/refs.shared';
import type { Walkthrough } from '../slides/model.shared';
import type { Anchor, Verdicts } from '../kernel/state/schema.shared';

/** The reviewer wrote `m` in `round`: what that round sends the agent. */
export const yoursIn = (m: Message, round: number) => m.author === 'you' && m.round === round;

// block tags break words, inline ones don't
export const plain = (html: string) => html.replace(/<\/?(p|div|li|br|h\d|ul|ol|tr|td|rr-flow|rr-node)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Where a tour anchor sits in the walkthrough: chapter and step indices, -1 when gone. */
const tourPosition = (a: { chapter: string; step: string }, w?: Walkthrough | null) => {
  const c = w?.chapters.findIndex((ch) => ch.id === a.chapter) ?? -1;
  return [c, c < 0 ? -1 : w!.chapters[c].steps.findIndex((s) => s.id === a.step)] as const;
};

const describeAnchor = (a: Anchor, walkthrough?: Walkthrough | null) => {
  switch (a.kind) {
    case 'doc':
      if (a.target === PR_DESCRIPTION)
        return `PR description (the author's text on GitHub; you cannot edit it, answer in the thread)${a.path ? ' > ' + a.path : ''}${a.quote ? ` - quote: "${a.quote.exact}"` : ''}`;
      return `walkthrough ${a.target ? '#' + a.target : '(top)'}${a.path ? ' > ' + a.path : ''}${a.quote ? ` - quote: "${a.quote.exact}"` : ''}`;
    case 'code':
      return `${a.path}:${a.start}${a.end !== a.start ? '-' + a.end : ''} (${a.pr ? `#${a.pr}, ` : ''}${a.rev === 'base' ? 'old/base side' : 'new/head side'}${a.sha ? `, at commit ${a.sha.slice(0, 7)}` : ''})`;
    case 'symbol':
      return `symbol ${a.name}`;
    case 'tour': {
      const [c, s] = tourPosition(a, walkthrough);
      if (s < 0) return `guided walkthrough slide ${a.chapter}/${a.step}${walkthrough ? ' (no longer in the guided walkthrough)' : ''}`;
      const ch = walkthrough!.chapters[c];
      return `guided walkthrough "${ch.title}" slide ${s + 1}/${ch.steps.length}: "${plain(ch.steps[s].text)}"`;
    }
    default:
      return 'general';
  }
};

/** One line saying what a thread is on; `walkthrough` gives a tour thread its slide (chapter, step n/m, text).
 *  Whitespace collapses: titles and quotes can come from a PR, and a line break could forge a heading in feedback. */
export const anchorText = (a: Anchor, walkthrough?: Walkthrough | null) => describeAnchor(a, walkthrough).replace(/\s+/g, ' ');

/** A PR of a stack, as feedback names it. */
export type StackRef = { number: number; title: string; headLabel: string };
/** The stack PR a thread is about: its code anchor's layer, the PR it is on GitHub, or its slide's chapter's. */
export const threadPr = (t: Pick<Thread, 'anchor' | 'pr'>, w?: Walkthrough | null) => {
  const a = t.anchor;
  return t.pr ?? (a.kind === 'code' ? a.pr : a.kind === 'tour' ? w?.chapters.find((c) => c.id === a.chapter)?.pr : undefined);
};
/** `items` a group per stack PR, bottom first, then those on the whole stack (or a PR no longer in it); `keep`: PRs
 *  listed even with nothing in them. Without a stack, one group. */
export function byPr<T>(items: T[], stack: StackRef[] | undefined, prOf: (t: T) => number | undefined, keep: (n: number) => boolean = () => false) {
  if (!stack) return [{ pr: undefined, items }];
  const groups = stack.map((pr) => ({ pr: pr as StackRef | undefined, items: items.filter((t) => prOf(t) === pr.number) })).filter((g) => g.items.length || keep(g.pr!.number));
  const rest = items.filter((t) => !stack.some((p) => p.number === prOf(t)));
  return rest.length ? [...groups, { pr: undefined, items: rest }] : groups;
}
const prTitle = (p: StackRef) => `#${p.number} ${p.title}`.replace(/\s+/g, ' '); // from GitHub: no line breaks into headings

/** Open GitHub threads as markdown: what colleagues said on the PR (a stack: grouped by PR). The agent can link them (rr:thread/<id>), not post to them. */
export function githubContext(threads: Thread[] = [], stack?: StackRef[]) {
  const open = threads.filter((t) => t.status === 'open' && t.messages.length);
  if (!open.length) return [];
  const lines = ['## Open on GitHub (colleagues; context only, not feedback for you to reply to)', '', 'You cannot post to these. Link one from review.html or a reply with rr:thread/<id> when it bears on your answer.', ''];
  for (const g of byPr(open, stack, threadPr)) {
    if (stack) lines.push(`### ${g.pr ? prTitle(g.pr) : 'Whole stack'}`, '');
    for (const t of g.items) {
      const [first, ...rest] = t.messages;
      const where = t.gh?.conversation ? 'PR conversation' : `${anchorText(t.anchor)}${t.gh?.outdated ? ', outdated' : ''}`;
      lines.push(`- ${t.id} (${where}) @${first.gh?.login}: ${first.body.replace(/<!--[\s\S]*?-->/g, '').trim().split('\n')[0].slice(0, 160)}${rest.length ? ` - ${rest.length} repl${rest.length > 1 ? 'ies' : 'y'}, last by @${rest[rest.length - 1].gh?.login}` : ''}`);
    }
    if (stack) lines.push('');
  }
  return stack ? lines : [...lines, ''];
}


export interface FeedbackOpts {
  kind: 'feedback' | 'approve';
  note?: string;
  /** The review dir; when known, the commands to run name it (agents run from anywhere). */
  dir?: string;
  codeExcerpt?: (a: Anchor) => string | null;
  /** The PR's GitHub threads, listed as context (colleagues' comments, not this reviewer's feedback). */
  github?: Thread[];
  /** walkthrough.json, for the slide a tour thread is on */
  walkthrough?: Walkthrough | null;
  /** A stack of PRs: what changed in its PRs since round `since` (cli/lib/git.ts headChanges), as this round showed it. */
  changes?: { since: number; lines: string[] };
  /** A stack of PRs, bottom first: threads are grouped by the PR they are on. */
  stack?: StackRef[];
  /** A stack: the reviewer's verdict per PR. */
  verdicts?: Verdicts;
}

const VERDICT = { approve: 'approved', changes: 'changes wanted', comment: 'comments only' } as const;

export function feedbackMarkdown(state: ReviewState, opts: FeedbackOpts) {
  const round = state.round;
  const at = opts.dir ? ` --dir '${opts.dir.replace(/'/g, `'\\''`)}'` : '';
  // walkthrough threads last, in tour order, so the agent reads them like the reviewer played them
  const order = (t: Thread) => {
    if (t.anchor.kind !== 'tour') return 0;
    const [c, s] = tourPosition(t.anchor, opts.walkthrough);
    return 1 + (c + 1) * 1e4 + (s + 1);
  };
  const touched = state.threads.filter((t) => t.messages.some((m) => yoursIn(m, round))).sort((a, b) => order(a) - order(b));
  const open = state.threads.filter((t) => t.status === 'open');
  const lines: string[] = [];
  if (opts.kind === 'approve') {
    lines.push(`# Review round ${round}: APPROVED`, '');
    if (opts.note) lines.push(opts.note, '');
    if (open.length) lines.push(`(${open.length} thread(s) still open - list them with \`reviewroom status --threads${at}\`)`);
    return lines.join('\n');
  }
  lines.push(`# Review feedback - round ${round}`, '');
  if (opts.note) lines.push('## Overall', '', opts.note, '');
  if (opts.changes?.lines.length) lines.push(`## The stack since round ${opts.changes.since} (what the reviewer saw this round)`, '', '```', ...opts.changes.lines, '```', '');
  lines.push(
    `${touched.length} thread(s) need your attention. For each one: answer with \`reviewroom reply <thread-id> "<markdown>"${at}\``,
    `(leave resolving to the reviewer), change code and/or the walkthrough (review.html) as needed,`,
    `mark new or changed sections with data-round="${round + 1}", then run \`reviewroom review${at}\` again to start round ${round + 1}.`,
    `Link to things instead of repeating them: rr:doc/<section-id>, rr:code/<path>#L<a>-<b>, rr:sym/<name>, rr:thread/<id>;`,
    `![](rr:...) on its own line embeds a live preview in the thread.`,
    '',
  );
  const { stack, verdicts = {} } = opts;
  // a stack: a section per PR, bottom first, saying where its fixes go; then the whole stack's threads
  for (const g of byPr(touched, stack, (t) => threadPr(t, opts.walkthrough), (n) => !!verdicts[n])) {
    if (stack) {
      const v = g.pr && verdicts[g.pr.number];
      lines.push(g.pr ? `## ${prTitle(g.pr)}${v ? ` - ${VERDICT[v]}` : ''}` : '## The whole stack', '', g.pr ? `Commit fixes for it on branch \`${g.pr.headLabel}\`.` : 'Threads on the stack as a whole: fix each on the branch of the PR that holds the code.', '');
    }
    for (const t of g.items) {
      lines.push(`${stack ? '###' : '##'} Thread ${t.id} - ${t.status}`, `Anchor: ${anchorText(t.anchor, opts.walkthrough)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
      const ex = opts.codeExcerpt?.(t.anchor);
      if (ex) lines.push('', '```', ex, '```');
      lines.push('');
      for (const m of t.messages) {
        const isNew = yoursIn(m, round);
        lines.push(`**${m.author}** (round ${m.round})${isNew ? ' - NEW' : ''}:`, '', m.body.replace(/^/gm, '> '), '');
      }
    }
  }
  lines.push(...githubContext(opts.github, stack));
  const viewed = Object.keys(state.viewed || {}).length;
  const checks = Object.entries(state.checks || {});
  if (checks.length) lines.push('## Open questions', '', ...checks.map(([k, v]) => `- [${v === 'pass' ? 'x' : ' '}] ${k}${v === 'fail' ? ' - NEEDS WORK' : ''}`), '');
  lines.push(`_Files marked viewed: ${viewed}. Open threads overall: ${open.length}._`);
  return lines.join('\n');
}
