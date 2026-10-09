// Shared by the CLI and the browser: turn the reviewer's round into a prompt the
// agent can act on. Plain JS so both Node and the bundle can import it.

const anchorText = (a) => {
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

const anchorRef = (a) => {
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
 * @param {{ note?: string, kind: 'feedback'|'approve', codeExcerpt?: (a:any)=>string|null }} opts
 */
export function feedbackMarkdown(state, opts) {
  const round = state.round;
  const touched = state.threads.filter((t) => t.messages.some((m) => m.author === 'you' && m.round === round));
  const open = state.threads.filter((t) => t.status === 'open');
  const lines = [];
  if (opts.kind === 'approve') {
    lines.push(`# Review round ${round}: APPROVED`, '');
    if (opts.note) lines.push(opts.note, '');
    if (open.length) lines.push(`(${open.length} thread(s) still open — see .readingroom/state.json)`);
    return lines.join('\n');
  }
  lines.push(`# Review feedback — round ${round}`, '');
  if (opts.note) lines.push('## Overall', '', opts.note, '');
  lines.push(
    `${touched.length} thread(s) need your attention. For each one: answer with \`readingroom reply <thread-id> "<markdown>"\``,
    `(add --resolve if the comment is fully addressed), change code and/or the narrative (review.html) as needed,`,
    `mark new or changed sections with data-round="${round + 1}", then run \`readingroom review\` again to start round ${round + 1}.`,
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
  const viewed = Object.keys(state.viewed || {}).length;
  const checks = Object.entries(state.checks || {});
  if (checks.length) lines.push('## Sign-off checklist', '', ...checks.map(([k, v]) => `- [${v === 'pass' ? 'x' : ' '}] ${k}${v === 'fail' ? ' — NEEDS WORK' : ''}`), '');
  lines.push(`_Files marked viewed: ${viewed}. Open threads overall: ${open.length}._`);
  return lines.join('\n');
}
