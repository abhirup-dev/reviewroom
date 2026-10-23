// Agent round and GitHub review controls.
import { h, icon, copyText, relTime } from '../kernel/dom';
import { feedbackMarkdown } from './feedback.shared';
import type { GitHubAction } from '../kernel/state/schema.shared';
import type { ReviewApp } from '../app';
import { noteDialog } from '../kernel/dialog';
import { popMenu, menuItem, menuLabel } from '../kernel/menus';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function sendDialog(app: ReviewApp) {
  const pending = app.pendingFeedback();
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Overall note for the agent (optional, markdown)' });
  const go = (kind: 'feedback' | 'approve') => async () => {
    const n = app.state.round;
    const text = note.value.trim() || undefined;
    if (app.backend.finish) {
      const res = await app.backend.finish(kind, text, n).catch((e) => ({ ok: false, message: String(e) }));
      if (!res.ok) {
        app.toast('Failed: ' + (res.message ?? 'unknown'), 'error');
        return false;
      }
      app.toast(kind === 'approve' ? 'Approved' : `Round ${n} sent`);
    } else {
      await copyText(feedbackMarkdown(app.state, { kind, note: text, walkthrough: app.walkthrough }));
      app.apply({ op: 'finishRound', kind, note: text, round: n });
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
        h('ul', { class: 'rr-send__list' }, ...pending.map((t) => h('li', null, h('span', { class: 'rr-chip rr-chip--static' }, app.anchorLabel(t.anchor)), ' ', plural(t.messages.filter((m) => m.author === 'you' && m.round === app.state.round).length, 'comment')))),
        note,
        app.backend.finish ? null : h('p', { class: 'rr-muted rr-small' }, 'Feedback will be copied for you to paste to your agent.'),
      ],
      [h('button', { class: 'rr-btn rr-btn--ghost', onclick: act(go('approve')) }, icon('check', 12), 'Approve'), h('span', { class: 'rr-toolbar__spacer' }), h('button', { class: 'rr-btn rr-btn--ghost', onclick: close }, 'Cancel'), h('button', { class: 'rr-btn rr-btn--primary', onclick: act(go('feedback')) }, icon('send', 12), 'Send feedback')],
    ],
  );
}

// ---------------------------------------------------------------- submit GitHub review
export function submitReviewDialog(app: ReviewApp) {
  const drafts = app.github?.pending?.drafts ?? 0;
  const note = h('textarea', { class: 'rr-composer__input', rows: '4', placeholder: 'Review summary (optional, markdown)' });
  const go = (done: string, action: () => GitHubAction) => async () => (await app.githubAct(action())) && (app.toast(done), true);
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

/** GitHub status + the Agent/Team switch: shown only for reviews of a GitHub PR. */
export function githubControls(app: ReviewApp) {
  const g = app.github;
  if (!g || (!g.ok && !g.threads?.length && /not a GitHub/.test(g.error ?? ''))) return [];
  const warn = !!g.error || !!g.stale;
  const btn = h(
    'button',
    { class: 'rr-hbtn' + (warn ? ' is-warn' : ''), 'aria-haspopup': 'menu', title: g.error ? 'GitHub: ' + g.error : g.stale ? 'The PR has new commits on GitHub' : `GitHub threads, as @${g.viewer}` },
    icon('thread', 14),
    h('span', null, g.error ? 'GitHub offline' : g.stale ? 'PR updated' : 'GitHub'),
    icon('chevronDown', 12),
  );
  btn.onclick = () =>
    popMenu(btn, (close) => [
      menuLabel(g.ok ? `Signed in as @${g.viewer} · fetched ${relTime(g.at ?? '')}` : 'GitHub'),
      g.error ? h('div', { class: 'rr-menu__note' }, g.error) : null,
      g.stale ? h('div', { class: 'rr-menu__note' }, `The PR has commits you aren't reviewing yet. Run \`reviewroom pr ${app.meta.number ?? '<n>'}\` again to update; comments still land on the right lines meanwhile.`) : null,
      menuItem('Refresh comments', () => (close(), app.refreshGitHub().then(() => app.toast('GitHub comments refreshed')))),
      g.url ? menuItem('Open the PR on GitHub', () => (close(), window.open(g.url, '_blank', 'noopener')), { icon: 'popout' }) : null,
    ]);
  if (!g.ok) return [btn];
  const seg = h(
    'div',
    { class: 'rr-seg rr-seg--small', role: 'group', 'aria-label': 'Review mode: where new comments go and which threads are listed' },
    ...(['agent', 'team', 'all'] as const).map((m) =>
      h(
        'button',
        {
          class: app.prefs.reviewMode === m ? 'is-on' : '',
          'aria-pressed': String(app.prefs.reviewMode === m),
          title: {
            agent: 'Agent review: your comments go to the agent, round by round; Threads lists the agent threads',
            team: "Team review: code and PR comments go to GitHub, for colleagues (narrative comments still go to the agent); Threads lists GitHub's threads",
            all: 'All: Threads lists agent and GitHub threads together; code and PR comments can go to either',
          }[m],
          onclick: () => app.setPref('reviewMode', m),
        },
        { agent: 'Agent', team: 'Team', all: 'All' }[m],
      ),
    ),
  );
  return [btn, seg];
}

/** Finish the agent round or submit the pending GitHub review, according to review mode. */
export function feedbackButton(app: ReviewApp): HTMLElement {
  const pending = app.pendingFeedback().length;
  const round = app.state.rounds.find((r) => r.n === app.state.round);
  return app.teamMode
    ? h(
        'button',
        { class: 'rr-btn rr-btn--primary rr-send-btn', title: 'Post your draft comments to GitHub as one review: comment, approve or request changes', onclick: () => submitReviewDialog(app) },
        icon('send', 14),
        h('span', null, 'Submit review'),
        app.github?.pending?.drafts ? h('span', { class: 'rr-badge' }, String(app.github.pending.drafts)) : null,
      )
    : h(
        'button',
        { class: 'rr-btn rr-btn--primary rr-send-btn', title: app.backend.finish ? 'Finish this round: the agent gets your new comments and starts the next round' : 'Copy this round’s comments as markdown to paste to your agent', 'data-keys': 'mod+shift+enter', onclick: () => sendDialog(app), disabled: round?.status !== 'open' && !!round },
        icon('send', 14),
        h('span', null, app.backend.finish ? 'Send feedback' : 'Export feedback'),
        pending ? h('span', { class: 'rr-badge' }, String(pending)) : null,
      );
}

/** Round navigation and the narrative comment picker, in their header order. */
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
    app.teamMode ? null : roundBtn,
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
