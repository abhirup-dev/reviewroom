import { describe, expect, test } from 'bun:test';
import { classifySession, sessionOpenUrl, surfacePath } from './classify.ts';
import { assessCompatibility } from './compat.ts';
import { critLoopbackUrl, isLoopbackHost, normalizeTimestamp, parseStrictPid, parseStrictPort, sanitizeLoopbackUrl } from './loopback.ts';

describe('classifySession', () => {
  test('reviewroom: a PR, uncommitted changes, a branch', () => {
    expect(classifySession({ tool: 'reviewroom', mode: 'review', label: 'x', pr: 42 })).toMatchObject({ kind: 'pull-request-review', target: '#42' });
    expect(classifySession({ tool: 'reviewroom', mode: 'serve', label: null, head: 'worktree' })).toMatchObject({ kind: 'code-review', target: 'uncommitted changes' });
    expect(classifySession({ tool: 'reviewroom', mode: 'serve', label: null, head: 'feat/a' }).target).toBe('feat/a');
  });

  test('Crit review surfaces from launch args', () => {
    expect(classifySession({ tool: 'crit', mode: 'review', label: null, args: [] }).kind).toBe('code-review');
    expect(classifySession({ tool: 'crit', mode: 'live', label: null, args: ['live', 'http://localhost:3000'] })).toMatchObject({ category: 'live-artifact', kind: 'live-web-review' });
    expect(classifySession({ tool: 'crit', mode: 'preview', label: null, args: ['preview', '/tmp/app.html'] }).kind).toBe('html-preview');
    expect(classifySession({ tool: 'crit', mode: 'plan', label: null, args: ['plan', '--name', 'x', '/tmp/plan.md'] }).kind).toBe('plan-review');
    expect(classifySession({ tool: 'crit', mode: 'review', label: null, args: ['--range', 'main..HEAD'] }).kind).toBe('commit-range-review');
    expect(classifySession({ tool: 'crit', mode: 'review', label: null, args: ['--mr', 'https://gitlab.com/a/b/-/merge_requests/4'] }).kind).toBe('merge-request-review');
    expect(classifySession({ tool: 'crit', mode: 'file', label: 'http://localhost:3000', args: ['http://localhost:3000'] }).kind).toBe('live-web-review');
  });

  test('Plannotator semantics refined by the process command', () => {
    expect(classifySession({ tool: 'plannotator', mode: 'review', label: 'review', command: 'plannotator review' }).kind).toBe('code-review');
    expect(classifySession({ tool: 'plannotator', mode: 'annotate', label: 'notes.md', command: 'plannotator annotate /tmp/notes.md --gate' }).kind).toBe('artifact-annotation');
    expect(classifySession({ tool: 'plannotator', mode: 'annotate', label: 'last', command: 'plannotator last --gate' }).kind).toBe('last-message-annotation');
    expect(classifySession({ tool: 'plannotator', mode: 'annotate', label: 'app', command: 'plannotator annotate http://localhost:4321/ --app' })).toMatchObject({ category: 'live-artifact', kind: 'live-web-review' });
    expect(classifySession({ tool: 'plannotator', mode: 'annotate', label: 'page.html', command: 'plannotator annotate /tmp/page.html' }).kind).toBe('html-preview');
    expect(classifySession({ tool: 'plannotator', mode: 'goal-setup', label: 'goal-setup-interview-demo', command: 'plannotator setup-goal interview bundle.json' }).kind).toBe('goal-setup');
    expect(classifySession({ tool: 'plannotator', mode: 'review', label: 'mr-review-project-4', command: 'plannotator review' }).kind).toBe('merge-request-review');
  });
});

describe('which page to open', () => {
  test("Crit's rendered surfaces use its launcher's paths (v0.19)", () => {
    expect(surfacePath('crit', 'html-preview')).toBe('/preview');
    expect(surfacePath('crit', 'live-web-review')).toBe('/live');
    expect(surfacePath('crit', 'code-review')).toBe('');
    expect(sessionOpenUrl('crit', 'http://localhost:6000', 'html-preview')).toBe('http://localhost:6000/preview');
    expect(sessionOpenUrl('crit', 'http://localhost:6000/prefix', 'live-web-review')).toBe('http://localhost:6000/prefix/live');
  });
  test("Plannotator's recorded URL is used unchanged", () => {
    for (const kind of ['code-review', 'html-preview', 'live-web-review', 'plan-review'] as const) expect(sessionOpenUrl('plannotator', 'http://localhost:7000/custom', kind)).toBe('http://localhost:7000/custom');
  });
});

describe('loopback validation', () => {
  test('loopback hosts', () => {
    for (const host of ['localhost', 'LOCALHOST.', '127.0.0.1', '127.0.1.5', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['example.com', '192.168.1.4', '0.0.0.0', 'localhost.evil.com', '', '127.999.0.1']) expect(isLoopbackHost(host)).toBe(false);
  });
  test('strict ports and pids', () => {
    expect([8080, 0, 65536, 8080.5, '8080', null].map(parseStrictPort)).toEqual([8080, null, null, null, null, null]);
    expect([12345, 0, -1, '12345', 1e12].map(parseStrictPid)).toEqual([12345, null, null, null, null]);
  });
  test('URLs: loopback http(s) only', () => {
    expect(sanitizeLoopbackUrl('http://localhost:51723/').url).toBe('http://localhost:51723/');
    expect(sanitizeLoopbackUrl('https://127.0.0.1:443/x').url).toBe('https://127.0.0.1/x');
    expect(sanitizeLoopbackUrl('https://my-app.loca.lt/session').note).toContain('non-loopback');
    for (const junk of ['', undefined, 'not a url', 'ftp://localhost:21', 42]) expect(sanitizeLoopbackUrl(junk).url).toBeNull();
  });
  test("Crit's host", () => {
    expect(critLoopbackUrl('', 49171)).toEqual({ url: 'http://localhost:49171', note: null });
    expect(critLoopbackUrl('127.0.0.1', 49171).url).toBe('http://localhost:49171');
    expect(critLoopbackUrl('0.0.0.0', 49171).note).toContain('non-loopback');
  });
  test('timestamps', () => {
    expect(normalizeTimestamp('2026-08-19T06:59:38.771342Z')).toBe('2026-08-19T06:59:38.771Z');
    expect(normalizeTimestamp('2026-08-24T16:26:00.210Z')).toBe('2026-08-24T16:26:00.210Z');
    for (const junk of ['', 'yesterday', 123]) expect(normalizeTimestamp(junk)).toBeNull();
  });
});

describe('tool versions', () => {
  test('the audited versions are verified', () => {
    expect(assessCompatibility({ crit: 'crit 0.19.0 (brew)', plannotator: 'plannotator 0.27.8' })).toEqual({
      crit: { installed: '0.19.0', verifiedAgainst: '0.19.0', status: 'verified' },
      plannotator: { installed: '0.27.8', verifiedAgainst: '0.27.8', status: 'verified' },
    });
  });
  test('a newer or missing version is never called verified', () => {
    const r = assessCompatibility({ crit: 'crit 0.20.0', plannotator: null });
    expect([r.crit.status, r.plannotator.status]).toEqual(['unverified', 'unavailable']);
  });
});
