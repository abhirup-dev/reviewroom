// Shared by the CLI and the browser: turn the reviewer's round into a prompt the
// agent can act on. No DOM or Node imports, so both the client bundle and the CLI can import it.
import type { Message, ReviewState, Thread } from '../kernel/state/model.shared';
import { anchorRef, PR_DESCRIPTION } from '../kernel/refs/refs.shared';
import type { Walkthrough } from '../slides/model.shared';
import type { Anchor } from '../kernel/state/schema.shared';


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
      return `${a.path}:${a.start}${a.end !== a.start ? '-' + a.end : ''} (${a.rev === 'base' ? 'old/base side' : 'new/head side'})`;
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

/** Open GitHub threads as markdown: what colleagues said on the PR. The agent can link them (rr:thread/<id>), not post to them. */
export function githubContext(threads: Thread[] = []) {
  const open = threads.filter((t) => t.status === 'open' && t.messages.length);
  if (!open.length) return [];
  const lines = ['## Open on GitHub (colleagues; context only, not feedback for you to reply to)', '', 'You cannot post to these. Link one from review.html or a reply with rr:thread/<id> when it bears on your answer.', ''];
  for (const t of open) {
    const [first, ...rest] = t.messages;
    const where = t.gh?.conversation ? 'PR conversation' : `${anchorText(t.anchor)}${t.gh?.outdated ? ', outdated' : ''}`;
    lines.push(`- ${t.id} (${where}) @${first.gh?.login}: ${first.body.replace(/<!--[\s\S]*?-->/g, '').trim().split('\n')[0].slice(0, 160)}${rest.length ? ` - ${rest.length} repl${rest.length > 1 ? 'ies' : 'y'}, last by @${rest[rest.length - 1].gh?.login}` : ''}`);
  }
  return [...lines, ''];
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
}

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
  lines.push(
    `${touched.length} thread(s) need your attention. For each one: answer with \`reviewroom reply <thread-id> "<markdown>"${at}\``,
    `(leave resolving to the reviewer), change code and/or the walkthrough (review.html) as needed,`,
    `mark new or changed sections with data-round="${round + 1}", then run \`reviewroom review${at}\` again to start round ${round + 1}.`,
    `Link to things instead of repeating them: rr:doc/<section-id>, rr:code/<path>#L<a>-<b>, rr:sym/<name>, rr:thread/<id>;`,
    `![](rr:...) on its own line embeds a live preview in the thread.`,
    '',
  );
  for (const t of touched) {
    lines.push(`## Thread ${t.id} - ${t.status}`, `Anchor: ${anchorText(t.anchor, opts.walkthrough)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
    const ex = opts.codeExcerpt?.(t.anchor);
    if (ex) lines.push('', '```', ex, '```');
    lines.push('');
    for (const m of t.messages) {
      const isNew = yoursIn(m, round);
      lines.push(`**${m.author}** (round ${m.round})${isNew ? ' - NEW' : ''}:`, '', m.body.replace(/^/gm, '> '), '');
    }
  }
  lines.push(...githubContext(opts.github));
  const viewed = Object.keys(state.viewed || {}).length;
  const checks = Object.entries(state.checks || {});
  if (checks.length) lines.push('## Open questions', '', ...checks.map(([k, v]) => `- [${v === 'pass' ? 'x' : ' '}] ${k}${v === 'fail' ? ' - NEEDS WORK' : ''}`), '');
  lines.push(`_Files marked viewed: ${viewed}. Open threads overall: ${open.length}._`);
  return lines.join('\n');
}
