// GitHub CI panel.
import { h, icon, relTime } from '../kernel/dom';
import type { CiCommit, CiState } from '../kernel/state/model.shared';
import { definePanel, type PanelInstance } from '../kernel/dock';
import type { ReviewApp } from '../app';

// ======================================================================= CI
const CI_WORD: Record<CiState, string> = { success: 'passed', failure: 'failed', pending: 'running', none: 'no checks' };
const ciDot = (s: CiState) => h('span', { class: 'rr-ci-dot is-' + s, 'aria-label': CI_WORD[s] });

/** The latest commit's CI; when it failed or is still running, also the last commit that passed. */
class CiPanel implements PanelInstance {
  element: HTMLElement;
  private off: () => void;
  constructor(private app: ReviewApp) {
    this.element = h('div', { class: 'rr-side' }, h('div', { class: 'rr-scroll rr-ci' }));
    this.off = app.bus.on('state', () => this.render());
    this.render();
  }

  private commit(c: CiCommit, label: string) {
    // only what needs attention is listed; passing checks collapse into a count
    const shown = c.checks.filter((x) => x.state !== 'success');
    const passed = c.checks.length - shown.length;
    return h(
      'div',
      { class: 'rr-ci-commit' },
      h('div', { class: 'rr-ci-commit__head' }, ciDot(c.state), h('span', { class: 'rr-ci-commit__label' }, label), h('span', { class: 'rr-muted' }, CI_WORD[c.state]), h('a', { class: 'rr-ci-commit__sha', href: c.url, target: '_blank', rel: 'noopener', title: 'Open this commit on GitHub' }, c.short), h('span', { class: 'rr-muted' }, relTime(c.at))),
      h('div', { class: 'rr-ci-commit__title', title: c.title }, c.title),
      ...shown.map((x) => h(x.url ? 'a' : 'span', { class: 'rr-ci-check', ...(x.url ? { href: x.url, target: '_blank', rel: 'noopener', title: 'Open this run' } : {}) }, ciDot(x.state), h('span', null, x.name))),
      passed ? h('div', { class: 'rr-ci-check rr-muted', title: c.checks.filter((x) => x.state === 'success').map((x) => x.name).join('\n') }, icon('check', 11), `${passed} passed`) : null,
    );
  }

  private render() {
    const g = this.app.github;
    const ci = g?.ci ?? [];
    const head = ci[0];
    const green = head && head.state !== 'success' ? ci.find((c) => c.state === 'success') : undefined;
    this.element.firstElementChild!.replaceChildren(
      ...(!head
        ? [h('div', { class: 'rr-empty' }, !g ? 'Loading…' : g.ok ? 'No commits on this PR' : 'CI shows for GitHub pull requests')]
        : [this.commit(head, 'Latest'), ...(head.state === 'success' ? [] : [green ? this.commit(green, 'Last passed') : h('div', { class: 'rr-empty' }, 'No commit on this PR has passed yet')])]),
    );
  }
  dispose() {
    this.off();
  }
}

definePanel({ id: 'ci', title: 'CI', icon: 'ci', create: (app) => new CiPanel(app) });
