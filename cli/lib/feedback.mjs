// Shared by the CLI and the browser: turn the reviewer's round into a prompt the
// agent can act on. Plain JS so both Node and the bundle can import it.

export const anchorText = (a) => {
  switch (a.kind) {
    case 'doc':
      return `narrative ${a.target ? '#' + a.target : '(top)'}${a.path ? ' > ' + a.path : ''}${a.quote ? ` — quote: "${a.quote.exact}"` : ''}`;
    case 'code':
      return `${a.path}:${a.start}${a.end !== a.start ? '-' + a.end : ''} (${a.rev === 'base' ? 'old/base side' : 'new/head side'})`;
    case 'symbol':
      return `symbol ${a.name}`;
    default:
      return 'general';
  }
};

/** Open GitHub threads as markdown: what colleagues said on the PR. The agent can link them (rr:thread/<id>), not post to them. */
export function githubContext(threads = []) {
  const open = threads.filter((t) => t.status === 'open' && t.messages.length);
  if (!open.length) return [];
  const lines = ['## Open on GitHub (colleagues; context only, not feedback for you to reply to)', '', 'You cannot post to these. Link one from review.html or a reply with rr:thread/<id> when it bears on your answer.', ''];
  for (const t of open) {
    const [first, ...rest] = t.messages;
    const where = t.gh?.conversation ? 'PR conversation' : `${anchorText(t.anchor)}${t.gh?.outdated ? ', outdated' : ''}`;
    lines.push(`- ${t.id} (${where}) @${first.gh?.login}: ${first.body.replace(/<!--[\s\S]*?-->/g, '').trim().split('\n')[0].slice(0, 160)}${rest.length ? ` — ${rest.length} repl${rest.length > 1 ? 'ies' : 'y'}, last by @${rest[rest.length - 1].gh?.login}` : ''}`);
  }
  return [...lines, ''];
}

export const anchorRef = (a) => {
  switch (a.kind) {
    case 'doc':
      return `rr:doc/${encodeURIComponent(a.target)}${a.path ? '/' + encodeURIComponent(a.path) : ''}`;
    case 'code':
      return `rr:code/${a.path}${a.rev === 'base' ? '@base' : ''}#L${a.start}${a.end !== a.start ? '-' + a.end : ''}`;
    case 'symbol':
      return `rr:sym/${encodeURIComponent(a.name)}`;
    default:
      return '';
  }
};

/**
 * @param {import('../../src/core/types').ReviewState} state
 * @param {{ note?: string, kind: 'feedback'|'approve', dir?: string, codeExcerpt?: (a:any)=>string|null, github?: any[] }} opts
 *   dir: the review dir; when known, the commands to run name it (agents run from anywhere)
 *   github: the PR's GitHub threads, listed as context (colleagues' comments, not this reviewer's feedback)
 */
export function feedbackMarkdown(state, opts) {
  const round = state.round;
  const at = opts.dir ? ` --dir '${opts.dir.replace(/'/g, `'\\''`)}'` : '';
  const touched = state.threads.filter((t) => t.messages.some((m) => m.author === 'you' && m.round === round));
  const open = state.threads.filter((t) => t.status === 'open');
  const lines = [];
  if (opts.kind === 'approve') {
    lines.push(`# Review round ${round}: APPROVED`, '');
    if (opts.note) lines.push(opts.note, '');
    if (open.length) lines.push(`(${open.length} thread(s) still open — list them with \`reviewroom threads${at}\`)`);
    return lines.join('\n');
  }
  lines.push(`# Review feedback — round ${round}`, '');
  if (opts.note) lines.push('## Overall', '', opts.note, '');
  lines.push(
    `${touched.length} thread(s) need your attention. For each one: answer with \`reviewroom reply <thread-id> "<markdown>"${at}\``,
    `(add --resolve if the comment is fully addressed), change code and/or the narrative (review.html) as needed,`,
    `mark new or changed sections with data-round="${round + 1}", then run \`reviewroom review${at}\` again to start round ${round + 1}.`,
    `Link to things instead of repeating them: rr:doc/<section-id>, rr:code/<path>#L<a>-<b>, rr:sym/<name>, rr:thread/<id>;`,
    `![](rr:…) on its own line embeds a live preview in the thread.`,
    '',
  );
  for (const t of touched) {
    lines.push(`## Thread ${t.id} — ${t.status}`, `Anchor: ${anchorText(t.anchor)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
    const ex = opts.codeExcerpt?.(t.anchor);
    if (ex) lines.push('', '```', ex, '```');
    lines.push('');
    for (const m of t.messages) {
      const isNew = m.round === round && m.author === 'you';
      lines.push(`**${m.author}** (round ${m.round})${isNew ? ' — NEW' : ''}:`, '', m.body.replace(/^/gm, '> '), '');
    }
  }
  lines.push(...githubContext(opts.github));
  const viewed = Object.keys(state.viewed || {}).length;
  const checks = Object.entries(state.checks || {});
  if (checks.length) lines.push('## Sign-off checklist', '', ...checks.map(([k, v]) => `- [${v === 'pass' ? 'x' : ' '}] ${k}${v === 'fail' ? ' — NEEDS WORK' : ''}`), '');
  lines.push(`_Files marked viewed: ${viewed}. Open threads overall: ${open.length}._`);
  return lines.join('\n');
}
