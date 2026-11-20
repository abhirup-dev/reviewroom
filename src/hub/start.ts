// Starting reviews from the hub's page (src/hub/index.ts): Add a PR by URL, Play a stopped review, Use my own agent,
// Remove a stopped review. The hub's server does the work (cli/hub/reviews.ts); each request names its action.
import { backdropCloses, h, icon } from '../kernel/dom';
import type { SessionInfo } from './model.shared';
import { ownAgentPrompt } from './prompt';

/** What the last Add, Play or Remove did: shown above the table until the next one. */
export type Notice = { text: string; risk?: boolean; link?: string };
/** What the page lends these actions. */
export interface HubPage {
  /** show a notice and repaint at once */
  say: (n: Notice) => void;
  refresh: () => Promise<void>;
  subject: (s: SessionInfo) => string;
  /** a review left the list: unselect it */
  forget: (id: string) => void;
}

/** Set by the macOS app (app/src/main.rs), which opens local pages in its tabs. */
export const inApp = 'reviewroomApp' in window;
/** Opened through a front (the public origin): loopback URLs don't reach this machine; reviews go through /r/<routeId>/. */
export const remote = !/^(127\.|localhost$|\[::1\]$)/.test(location.hostname);

const action = (name: string, init: RequestInit = {}) => ({ ...init, method: 'POST', headers: { 'content-type': 'application/json', 'x-reviewroom-action': name } });

/** Add a PR: a URL field and its button. */
export function addForm(page: HubPage): HTMLElement {
  const addUrl = h('input', { class: 'rr-input rr-hub__add', type: 'url', required: true, placeholder: 'https://github.com/owner/repo/pull/123', 'aria-label': 'Pull request URL', title: 'A GitHub pull request: the hub clones (or fetches) its repository and sets up its review, stopped until you Play it. Adding one again picks up new commits' });
  const addBtn = h('button', { class: 'rr-btn rr-btn--small rr-btn--primary', type: 'submit', title: 'Set up a review of this pull request' }, 'Add PR');
  const add = async () => {
    addBtn.disabled = true;
    page.say({ text: `Adding ${addUrl.value.trim()}: cloning or fetching, then setting up the review…` });
    const r = await fetch('/api/reviews', action('add-review', { body: JSON.stringify({ url: addUrl.value.trim() }) })).catch((e: Error) => e);
    const body = r instanceof Error ? { error: r.message } : ((await r.json().catch(() => ({}))) as { error?: string; running?: boolean });
    const failed = r instanceof Error || !r.ok;
    page.say(failed ? { text: body.error ?? 'Could not add the PR.', risk: true } : { text: body.running ? 'This review is already running.' : 'Added. Play it to start its review.' });
    if (!failed) addUrl.value = '';
    addBtn.disabled = false;
    await page.refresh();
  };
  return h('form', { class: 'rr-hub__addform', onsubmit: (e: Event) => { e.preventDefault(); void add(); } }, addUrl, addBtn);
}

/** Play, the built-in path: start a stopped review with the built-in assistant writing it (unless it is written
 *  already), then open it the way the hub's links open (a new tab; the macOS app takes it into its own tab). */
export async function play(page: HubPage, s: SessionInfo) {
  page.say({ text: `Starting “${page.subject(s)}”…` });
  const r = await fetch(`/api/reviews/${encodeURIComponent(s.routeId ?? '')}/play`, action('play-review')).catch((e: Error) => e);
  type Played = { error?: string; url?: string; generate?: { ok: boolean; started?: boolean; error?: string } | null };
  const body = r instanceof Error ? { error: r.message } : ((await r.json().catch(() => ({}))) as Played);
  if (r instanceof Error || !r.ok || !body.url) {
    page.say({ text: body.error ?? 'The review did not start.', risk: true });
    return page.refresh();
  }
  const url = remote ? `/r/${s.routeId}/` : body.url;
  const g = body.generate;
  let notice: Notice = g && !g.ok ? { text: `Started, but the assistant is not writing it: ${g.error}`, risk: true } : { text: g?.started ? 'Started; the built-in assistant is writing the walkthrough and report.' : 'Started.' };
  // after the request the click's activation may have expired: a blocked tab gets a link instead
  const tab = window.open(url, '_blank');
  if (tab) tab.opener = null;
  else if (!inApp) notice = { ...notice, text: `${notice.text} Your browser blocked the new tab:`, link: url };
  page.say(notice);
  await page.refresh();
}

/** A small modal: a title, what it says, and its buttons after Cancel/Close. */
function modal(label: string, body: HTMLElement[], last: (close: () => void) => HTMLButtonElement, dismiss = 'Cancel') {
  const close = () => box.close();
  const button = last(close);
  const box = h(
    'dialog',
    { class: 'rr-modal rr-modal--narrow', 'aria-label': label.replace(/\?$/, ''), onmousedown: backdropCloses, onclose: () => box.remove() },
    h('header', { class: 'rr-thread__head' }, h('strong', null, label), h('span', { class: 'rr-hub__spacer' }), h('button', { class: 'rr-icon-btn', 'aria-label': 'Cancel', title: 'Cancel', onclick: close }, icon('close', 14))),
    h('div', { class: 'rr-send__body' }, ...body),
    h('footer', { class: 'rr-composer__foot rr-hub__foot' }, h('button', { class: 'rr-btn', onclick: close }, dismiss), button),
  );
  document.body.append(box);
  box.showModal();
  button.focus();
}

/** "Use my own agent": the prompt for an agent the reviewer runs themselves (prompt.ts). The hub starts nothing. */
export function ownAgent(s: SessionInfo) {
  const text = ownAgentPrompt(s.reviewId ?? s.reviewPath ?? '', s.repoRoot ?? s.cwd ?? '.');
  modal('Use my own agent', [h('p', { class: 'rr-hub__p' }, 'Paste this into your agent (Claude Code, Codex, …). Your agent writes the review.'), h('pre', { class: 'rr-hub__prompt' }, text)], () => {
    const copy = h('button', { class: 'rr-btn rr-btn--primary', onclick: () => void navigator.clipboard.writeText(text).then(() => (copy.textContent = 'Copied'), () => (copy.textContent = 'Copy failed: select the text')) }, 'Copy');
    return copy;
  }, 'Close');
}

/** Remove a stopped review's folder; asks first only if it holds work (documents, threads, the assistant's transcript). */
export function removeReview(page: HubPage, s: SessionInfo) {
  const go = async (confirmed = false) => {
    const r = await fetch(`/api/reviews/${encodeURIComponent(s.routeId ?? '')}/remove`, action('remove-review', { body: JSON.stringify({ confirmed }) })).catch((e: Error) => e);
    const error = r instanceof Error ? r.message : r.ok ? null : (((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'It was not removed.');
    page.say(error ? { text: error, risk: true } : { text: `Removed “${page.subject(s)}”.` });
    page.forget(s.id);
    await page.refresh();
  };
  if (!s.hasWork) return void go();
  modal('Remove review?', [
    h('p', { class: 'rr-hub__p' }, `Review artifacts will be lost: the walkthrough, report, threads and assistant conversation of “${page.subject(s)}”.`),
    h('p', { class: 'rr-hub__p rr-hub__dim' }, 'The repository and its clone stay. Adding the PR again starts a fresh review.'),
  ], (close) => {
    const confirm = h('button', { class: 'rr-btn rr-btn--primary', onclick: () => { confirm.disabled = true; void go(true).finally(close); } }, 'Remove review');
    return confirm;
  });
}
