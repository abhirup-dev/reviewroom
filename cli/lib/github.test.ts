import { expect, test } from 'bun:test';
import { ciOf, normalize, prTarget, toGitHubMarkdown } from './github.ts';

const author = (login) => ({ login, avatarUrl: `https://avatars.example/${login}` });
const comment = (databaseId, login, body, extra = {}) => ({ id: `C${databaseId}`, databaseId, body, createdAt: `2026-10-0${databaseId % 9}T00:00:00Z`, url: `https://github.com/o/r/pull/7#c${databaseId}`, viewerCanUpdate: login === 'me', viewerCanDelete: login === 'me', author: author(login), ...extra });
const thread = (over, comments) => ({ id: 'T' + comments[0].databaseId, isResolved: false, path: 'a.go', line: 12, startLine: 10, diffSide: 'RIGHT', startDiffSide: 'RIGHT', originalLine: 9, originalStartLine: 8, subjectType: 'LINE', viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, comments: { nodes: comments }, ...over });
const pr = {
  id: 'PR1',
  body: 'Adds the thing.',
  createdAt: '2026-10-01T00:00:00Z',
  author: author('ann'),
  url: 'https://github.com/o/r/pull/7',
  headRefOid: 'b'.repeat(40),
  reviewThreads: {
    nodes: [
      thread({}, [comment(1, 'ann', 'why?'), comment(2, 'me', 'because')]),
      thread({ line: null, startLine: null, diffSide: 'LEFT', isResolved: true }, [comment(3, 'ann', 'old')]),
      thread({ line: null, startLine: null, subjectType: 'FILE' }, [comment(4, 'ann', 'whole file')]),
      thread({}, [comment(5, 'me', 'draft', { state: 'PENDING' })]),
    ],
  },
  comments: { nodes: [comment(6, 'bob', 'LGTM overall')] },
  reviews: { nodes: [{ id: 'R1', databaseId: 7, body: '', state: 'APPROVED', createdAt: '2026-10-08T00:00:00Z', url: 'u', viewerCanUpdate: false, author: author('bob') }, { id: 'R2', databaseId: 8, body: '', state: 'COMMENTED', createdAt: '2026-10-08T00:00:00Z', url: 'u', author: author('ann') }, { id: 'R3', databaseId: 9, body: '', state: 'PENDING', createdAt: '2026-10-09T00:00:00Z', url: 'u', author: author('me') }] },
};

test('GitHub threads map onto reviewroom threads and anchors', () => {
  const s = normalize(pr, 'me', 'a'.repeat(40));
  expect(s.stale).toBe(true);
  expect(s.pending).toEqual({ id: 'R3', drafts: 1 });
  expect(s.description).toEqual({ body: 'Adds the thing.', login: 'ann', avatar: 'https://avatars.example/ann', at: '2026-10-01T00:00:00Z' });
  const [live, outdated, file, draft, convo] = s.threads;
  expect(live.id).toBe('gh_1');
  expect(live.anchor).toEqual({ kind: 'code', path: 'a.go', rev: 'head', start: 10, end: 12 });
  expect(live.messages.map((m) => [m.gh.login, m.gh.mine, m.gh.canEdit])).toEqual([['ann', false, false], ['me', true, true]]);
  // no current line: placed where it was written, flagged so the diff doesn't show it on a wrong line
  expect(outdated.anchor).toEqual({ kind: 'code', path: 'a.go', rev: 'base', start: 8, end: 9 });
  expect([outdated.status, outdated.gh.outdated]).toEqual(['resolved', true]);
  expect([file.gh.file, file.gh.outdated]).toEqual([true, false]);
  expect(draft.messages[0].gh.pending).toBe(true);
  // conversation: comments + reviews with a verdict or text, never the pending review
  expect(convo.id).toBe('gh_conversation');
  expect(convo.messages.map((m) => m.body)).toEqual(['LGTM overall', '**Approved**']);
});

test('rr: links become GitHub links or plain text', () => {
  const t = { host: 'github.com', owner: 'o', name: 'r', number: 7 };
  const out = toGitHubMarkdown('see [x](rr:code/a.go#L3-5), [old](rr:code/a.go@base#L2), [intro](rr:doc/intro), [that](rr:thread/gh_42) and [mine](rr:thread/t3)', t, { base: 'B', head: 'H' });
  expect(out).toBe('see [x](https://github.com/o/r/blob/H/a.go#L3-L5), [old](https://github.com/o/r/blob/B/a.go#L2), intro, [that](https://github.com/o/r/pull/7#discussion_r42) and mine');
  expect(toGitHubMarkdown('[s](rr:code/my%20dir/a.go#L1)', t, { base: 'B', head: 'H' })).toBe('[s](https://github.com/o/r/blob/H/my%20dir/a.go#L1)');
});

test('the PR comes from config url, else repo + number', () => {
  expect(prTarget({ url: 'https://ghe.corp/o/r/pull/12' })).toEqual({ host: 'ghe.corp', owner: 'o', name: 'r', number: 12 });
  expect(prTarget({ repo: 'o/r', number: 3 })).toEqual({ host: 'github.com', owner: 'o', name: 'r', number: 3 });
  expect(prTarget({ repo: 'o/r' })).toBe(null);
});

test('CI: each commit is running, failed, passed or unchecked, newest first', () => {
  const run = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: 'd', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } });
  const st = (context, state) => ({ __typename: 'StatusContext', context, state, targetUrl: null });
  const commit = (oid, ...nodes) => ({ commit: { oid, abbreviatedOid: oid, messageHeadline: oid, committedDate: '', url: '', statusCheckRollup: nodes.length ? { contexts: { nodes } } : null } });
  const ci = ciOf([commit('a', run('lint', 'COMPLETED', 'SUCCESS'), st('jenkins', 'SUCCESS')), commit('b', run('lint', 'COMPLETED', 'FAILURE'), run('skip', 'COMPLETED', 'SKIPPED')), commit('c', run('lint', 'COMPLETED', 'FAILURE'), st('jenkins', 'PENDING')), commit('d')]);
  expect(ci.map((c) => [c.sha, c.state])).toEqual([['d', 'none'], ['c', 'pending'], ['b', 'failure'], ['a', 'success']]);
  expect(ci[3].checks).toEqual([{ name: 'CI / lint', state: 'success', url: 'd' }, { name: 'jenkins', state: 'success', url: null }]);
});
