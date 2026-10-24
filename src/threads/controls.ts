// Agent round and GitHub review controls.
import { h, icon, copyText, plural, relTime, seg } from '../kernel/dom';
import { feedbackMarkdown, yoursIn } from './feedback.shared';
import type { GitHubAction, Verdicts } from '../kernel/state/schema.shared';
import { currentRound } from '../kernel/state/ops.shared';
import type { ReviewApp } from '../app';
import { noteDialog } from '../kernel/dialog';
import { popMenu, menuItem, menuLabel } from '../kernel/menus';


export function sendDialog(app: ReviewApp) {
  const pending = app.services.threads.pendingFeedback();
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Overall note for the agent (optional, markdown)' });
  // a stack: a verdict per open PR, wanting changes where this round has new comments
  const open = app.meta.stack?.filter((p) => p.state !== 'merged' && p.state !== 'closed');
  const verdicts: Verdicts | undefined = open && Object.fromEntries(open.map((p) => [String(p.number), pending.some((t) => app.services.threads.prOf(t) === p.number) ? 'changes' : 'comment']));
  const go = (asked: 'feedback' | 'approve') => async () => {
    const n = app.state.round;
    const text = note.value.trim() || undefined;
    const kind = verdicts ? (Object.values(verdicts).every((v) => v === 'approve') ? 'approve' : 'feedback') : asked;
    if (app.backend.finish) {
      const res = await app.backend.finish(kind, text, n, verdicts).catch((e) => ({ ok: false, message: String(e) }));
      if (!res.ok) {
        app.toast('Failed: ' + (res.message ?? 'unknown'), 'error');
        return false;
      }
      app.toast(kind === 'approve' ? 'Approved' : `Round ${n} sent`);
    } else {
      await copyText(feedbackMarkdown(app.state, { kind, note: text, walkthrough: app.walkthrough, stack: app.meta.stack, verdicts }));
      app.apply({ op: 'finishRound', kind, note: text, round: n, verdicts });
      app.toast('Feedback copied — paste it to your agent');
    }
    return true;
  };
  noteDialog(
    'Finish round',
    `Finish round ${app.state.round}`,
    note,
    (act, close) => [
      [
        h('p', { class: 'rr-muted' }, pending.length ? `${plural(pending.length, 'thread')} with new comments:` : 'No new comments this round.'),
        h('ul', { class: 'rr-send__list' }, ...pending.map((t) => h('li', null, h('span', { class: 'rr-chip rr-chip--static' }, app.anchorLabel(t.anchor)), ' ', plural(t.messages.filter((m) => yoursIn(m, app.state.round)).length, 'comment')))),
        verdicts ? verdictRows(app, verdicts) : null,
        note,
        app.backend.finish ? null : h('p', { class: 'rr-muted rr-small' }, 'Feedback will be copied for you to paste to your agent.'),
      ],
      [...(verdicts ? [] : [h('button', { class: 'rr-btn rr-btn--ghost', onclick: act(go('approve')) }, icon('check', 12), 'Approve')]), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-btn rr-btn--ghost', onclick: close }, 'Cancel'), h('button', { class: 'rr-btn rr-btn--primary', onclick: act(go('feedback')) }, icon('send', 12), 'Send feedback')],
    ],
  );
}

const VERDICT = { approve: 'Approve', changes: 'Changes', comment: 'Comment' } as const;
/** One row per open PR of a stack: its verdict for the agent (edits `verdicts` in place). */
function verdictRows(app: ReviewApp, verdicts: Verdicts) {
  const box = h('div', { class: 'rr-verdicts', role: 'group', 'aria-label': 'Verdict per PR' });
  const paint = () =>
    box.replaceChildren(
      ...Object.keys(verdicts).map((n) => {
        const p = app.meta.stack!.find((x) => String(x.number) === n)!;
        return h(
          'div',
          { class: 'rr-verdicts__row' },
          h('span', { class: 'rr-stack-row__n' }, `#${n}`),
          h('span', { class: 'rr-verdicts__t', title: p.title }, p.title),
          h('div', { class: 'rr-seg rr-seg--small' }, ...(['approve', 'changes', 'comment'] as const).map((v) => h('button', { class: verdicts[n] === v ? 'is-on' : '', 'aria-pressed': String(verdicts[n] === v), title: { approve: `#${n} is good to merge`, changes: `#${n} needs the agent's changes`, comment: `Comments on #${n}, no verdict` }[v], onclick: () => ((verdicts[n] = v), paint()) }, VERDICT[v]))),
        );
      }),
    );
  paint();
  return box;
}

// ---------------------------------------------------------------- submit GitHub review
export function submitReviewDialog(app: ReviewApp) {
  if (app.meta.stack) return submitStackDialog(app);
  const drafts = app.github?.pending?.drafts ?? 0;
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Review summary (optional, markdown)' });
  const go = (done: string, action: () => GitHubAction) => async () => (await app.services.github.act(action())) && (app.toast(done), true);
  const submit = (event: Extract<GitHubAction, { action: 'submit' }>['event'], done: string) => go(done, () => ({ action: 'submit', event, body: note.value }));
  noteDialog(
    'Submit review on GitHub',
    'Submit your review on GitHub',
    note,
    (act) => [
      [
        h('p', { class: 'rr-muted' }, drafts ? `${plural(drafts, 'draft comment')} will be posted with it, visible to everyone on the PR.` : 'No draft comments: this posts just the summary and your verdict.'),
        note,
        drafts ? h('button', { class: 'rr-link-btn', title: 'Delete every draft comment in this review', onclick: act(go('Drafts discarded', () => ({ action: 'discard' }))) }, 'Discard all drafts') : null,
      ],
      [
        h('button', { class: 'rr-btn rr-btn--ghost', title: 'Ask for changes before this can merge', onclick: act(submit('request_changes', 'Review submitted: changes requested')) }, 'Request changes'),
        h('button', { class: 'rr-btn rr-btn--ghost', onclick: act(submit('approve', 'Review submitted: approved')) }, icon('check', 12), 'Approve'),
        h('span', { class: 'rr-toolbar__spacer' }),
        h('button', { class: 'rr-btn rr-btn--primary', title: 'Post your comments without approving or blocking', onclick: act(submit('comment', 'Review submitted')) }, icon('send', 12), 'Comment'),
      ],
    ],
  );
}

/** A stack: one GitHub review per PR picked (those with drafts, else the one in scope), posted one at a time so a
 *  failure leaves the ones already posted unticked and a retry sends only the rest. */
function submitStackDialog(app: ReviewApp) {
  const drafts = app.services.threads.drafts();
  const prs = app.meta.stack!.filter((p) => p.state !== 'merged' && p.state !== 'closed');
  const picked = new Set(prs.filter((p) => drafts.has(p.number)).map((p) => p.number));
  if (!picked.size && app.range?.pr) picked.add(app.range.pr);
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Review summary for each PR picked (optional, markdown)' });
  const rows = h('div', { class: 'rr-verdicts', role: 'group', 'aria-label': 'PRs to review' });
  const paint = () =>
    rows.replaceChildren(
      ...prs.map((p) =>
        h(
          'label',
          { class: 'rr-verdicts__row' },
          h('input', { type: 'checkbox', checked: picked.has(p.number), onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? picked.add(p.number) : picked.delete(p.number)) }),
          h('span', { class: 'rr-verdicts__t', title: p.title }, h('strong', null, `#${p.number} `), p.title),
          h('span', { class: 'rr-muted' }, drafts.get(p.number) ? plural(drafts.get(p.number)!, 'draft') : 'no drafts'),
        ),
      ),
    );
  paint();
  const each = (what: (n: number) => GitHubAction, done: string) => async () => {
    if (!picked.size) return app.toast('Pick a PR first', 'error'), false;
    const sent: number[] = [];
    for (const n of picked) {
      if (!(await app.services.github.act(what(n)))) {
        paint();
        if (sent.length) app.toast(`${done} on ${sent.map((x) => `#${x}`).join(', ')}; #${n} failed: try it again`, 'error');
        return false;
      }
      picked.delete(n);
      sent.push(n);
    }
    app.toast(`${done} on ${sent.map((x) => `#${x}`).join(', ')}`);
    return true;
  };
  const submit = (event: Extract<GitHubAction, { action: 'submit' }>['event'], done: string) => each((pr) => ({ action: 'submit', event, body: note.value, pr }), done);
  noteDialog('Submit reviews on GitHub', 'Submit your reviews on GitHub', note, (act) => [
    [
      h('p', { class: 'rr-muted' }, 'One review on each PR picked, with its own drafts, visible to everyone on it.'),
      rows,
      note,
      drafts.size ? h('button', { class: 'rr-link-btn', title: 'Delete every draft comment on the PRs picked', onclick: act(each((pr) => ({ action: 'discard', pr }), 'Drafts discarded')) }, 'Discard their drafts') : null,
    ],
    [
      h('button', { class: 'rr-btn rr-btn--ghost', title: 'Ask for changes before these can merge', onclick: act(submit('request_changes', 'Changes requested')) }, 'Request changes'),
      h('button', { class: 'rr-btn rr-btn--ghost', onclick: act(submit('approve', 'Approved')) }, icon('check', 12), 'Approve'),
      h('span', { class: 'rr-toolbar__spacer' }),
      h('button', { class: 'rr-btn rr-btn--primary', title: 'Post your comments without approving or blocking', onclick: act(submit('comment', 'Review submitted')) }, icon('send', 12), 'Comment'),
    ],
  ]);
}

/** GitHub status + the Agent/Team switch: shown only for reviews of a GitHub PR. */
export function githubControls(app: ReviewApp) {
  const g = app.github;
  if (!g || (!g.ok && !g.threads?.length && /not a GitHub/.test(g.error ?? ''))) return [];
  // a stack: any of its PRs with commits not reviewed yet
  const staleIn = Object.entries(g.prs ?? {}).filter(([, p]) => p.stale).map(([n]) => `#${n}`);
  const stale = !!g.stale || staleIn.length > 0;
  const warn = !!g.error || stale;
  const btn = h(
    'button',
    { class: 'rr-hbtn' + (warn ? ' is-warn' : ''), 'aria-haspopup': 'menu', title: g.error ? 'GitHub: ' + g.error : stale ? `${staleIn.length ? staleIn.join(', ') : 'The PR'} ha${staleIn.length > 1 ? 've' : 's'} new commits on GitHub` : `GitHub threads, as @${g.viewer}` },
    icon('thread', 14),
    h('span', null, g.error ? 'GitHub offline' : stale ? (staleIn.length ? `${staleIn.join(', ')} updated` : 'PR updated') : 'GitHub'),
    icon('chevronDown', 12),
  );
  btn.onclick = () =>
    popMenu(btn, (close) => [
      menuLabel(g.ok ? `Signed in as @${g.viewer} · fetched ${relTime(g.at ?? '')}` : 'GitHub'),
      g.error ? h('div', { class: 'rr-menu__note' }, g.error) : null,
      stale ? h('div', { class: 'rr-menu__note' }, `${staleIn.length ? staleIn.join(', ') : 'The PR'} ha${staleIn.length > 1 ? 've' : 's'} commits you aren't reviewing yet. Run \`reviewroom pr ${app.meta.number ?? '<n>'}\` again to update; comments still land on the right lines meanwhile.`) : null,
      menuItem('Refresh comments', () => (close(), app.services.github.refresh().then(() => app.toast('GitHub comments refreshed')))),
      g.url ? menuItem('Open the PR on GitHub', () => (close(), window.open(g.url, '_blank', 'noopener')), { icon: 'popout' }) : null,
    ]);
  if (!g.ok) return [btn];
  const modes = seg(
    (['agent', 'team', 'all'] as const).map((m) => ({
      label: { agent: 'Agent', team: 'Team', all: 'All' }[m],
      title: {
        agent: 'Agent review: your comments go to the agent, round by round; Threads lists the agent threads',
        team: "Team review: code and PR comments go to GitHub, for colleagues (narrative comments still go to the agent); Threads lists GitHub's threads",
        all: 'All: Threads lists agent and GitHub threads together; code and PR comments can go to either',
      }[m],
      on: app.prefs.reviewMode === m,
      onclick: () => app.setPref('reviewMode', m),
    })),
    { class: 'rr-seg rr-seg--small', 'aria-label': 'Review mode: where new comments go and which threads are listed' },
  );
  return [btn, modes];
}

/** Finish the agent round or submit the pending GitHub review, according to review mode. */
export function feedbackButton(app: ReviewApp): HTMLElement {
  const pending = app.services.threads.pendingFeedback().length;
  const round = currentRound(app.state);
  return app.services.threads.teamMode
    ? h(
        'button',
        { class: 'rr-btn rr-btn--primary rr-send-btn', title: 'Post your draft comments to GitHub as one review: comment, approve or request changes', onclick: () => submitReviewDialog(app) },
        icon('send', 14),
        h('span', null, 'Submit review'),
        app.services.threads.drafts().size ? h('span', { class: 'rr-badge' }, String([...app.services.threads.drafts().values()].reduce((a, b) => a + b, 0))) : null,
      )
    : h(
        'button',
        { class: 'rr-btn rr-btn--primary rr-send-btn', title: app.backend.finish ? 'Finish this round: the agent gets your new comments and starts the next round' : 'Copy this round’s comments as markdown to paste to your agent', 'data-keys': 'mod+shift+enter', onclick: () => sendDialog(app), disabled: round?.status !== 'open' && !!round },
        icon('send', 14),
        h('span', null, app.backend.finish ? 'Send feedback' : 'Export feedback'),
        pending ? h('span', { class: 'rr-badge' }, String(pending)) : null,
      );
}

/** Round navigation and the walkthrough comment picker, in their header order. */
export function threadHeaderControls(app: ReviewApp): (HTMLElement | null)[] {
  const roundBtn = h('button', { class: 'rr-hbtn', 'aria-haspopup': 'menu', title: 'Review rounds: view the narrative as it was at the end of an earlier round' }, icon('round', 14), h('span', null, `Round ${app.state.round}`), icon('chevronDown', 12));
  roundBtn.onclick = () =>
    popMenu(roundBtn, (close) => [
      menuLabel('Review rounds'),
      ...app.state.rounds
        .slice()
        .reverse()
        .map((r) =>
          menuItem(
            `Round ${r.n}`,
            () => {
              close();
              app.bus.emit('round-view', r.n === app.state.round ? 0 : r.n);
            },
            { checked: (app.viewRound || app.state.round) === r.n, hint: r.status === 'open' ? 'current' : r.status },
          ),
        ),
    ]);
  return [
    app.services.threads.teamMode ? null : roundBtn,
    h('button', { class: 'rr-hbtn rr-hbtn--icon' + (app.root.classList.contains('is-picking') ? ' is-on' : ''), title: 'Pick any element in the narrative to comment on (or hold Alt while hovering)', 'data-keys': 'x', 'aria-label': 'Pick element to comment', onclick: () => app.bus.emit('picker', !app.root.classList.contains('is-picking')) }, icon('target', 16)),
  ];
}

/** Feature events which affect header controls beyond the shell's ordinary repaint events. */
export function subscribeThreadHeader(app: ReviewApp, paint: () => void): () => void {
  const offs = [
    app.bus.on('picker', (on) => {
      app.root.classList.toggle('is-picking', on);
      paint();
    }),
    app.bus.on('round-view', () => setTimeout(paint)),
  ];
  return () => offs.forEach((off) => off());
}

/** Agent round status indicators, before the shell connection/save indicators. */
export function roundStatusControls(): HTMLElement[] {
  return [
    h('span', { class: 'rr-round-status rr-round-status--waiting', title: 'Your feedback went to the agent. The next round opens here when it is back' }, 'Waiting for the agent…'),
    h('span', { class: 'rr-pill rr-pill--ok rr-round-status rr-round-status--approved', title: 'You approved this review; the reviewroom server has stopped' }, 'Approved'),
  ];
}
