import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { until } from '../src/testing/wait.ts';
import { progressLines } from '../cli/lib/progress.ts';
import { setup } from './fixture.ts';
import { reviewEvents } from './transport.ts';

const { tmp, repo, dir, d, cli } = setup({ repo: 'tiny', scaffold: false });
const prArgs = ['pr', 'feature', '--base', 'main', '--no-open', '--port', '0', '--repo', repo];
test('pr requests only on creation/force; watcher pushes progress without reload until check passes', async () => {
  const initial = await cli([...prArgs, '--force']);
  expect(initial.code).toBe(0);

  const requested = progressLines(dir).filter((l) => l.event === 'requested');
  expect(requested.map((l) => [l.artifact, 'by' in l && l.by])).toEqual([['walkthrough', 'agent'], ['report', 'agent']]);
  const url = (await cli(prArgs)).stdout.trim();
  expect(progressLines(dir).filter((l) => l.event === 'requested')).toEqual(requested);
  const stream = await reviewEvents(url);
  try {
    await stream.find('hello');
    for (const text of ['<rr-app><rr-review>', '<rr-app><rr-review><section id="summary"><h1>Summary</h1></section></rr-review></rr-app>']) {
      fs.writeFileSync(path.join(dir, REPORT_FILE), text);
      await until(async () => (await fetch(url + 'api/progress').then((r) => r.json())).report.state === 'writing');
    }
    expect(stream.events.filter((e) => e.event === 'review')).toHaveLength(0);
    expect((await cli(['check', ...d])).code).toBe(0);
    await stream.find('review');
    expect((await fetch(url + 'api/progress').then((r) => r.json())).report.state).toBe('validated');
    // the same bytes saved again: the watcher fires, but the state did not change, so pages get no progress event
    const progressEvents = () => stream.events.filter((e) => e.event === 'progress').length;
    const sent = progressEvents();
    fs.writeFileSync(path.join(dir, REPORT_FILE), fs.readFileSync(path.join(dir, REPORT_FILE)));
    await Bun.sleep(600);
    expect(progressEvents()).toBe(sent);
    fs.appendFileSync(path.join(dir, REPORT_FILE), '<!-- another save -->');
    await until(async () => (await fetch(url + 'api/progress').then((r) => r.json())).report.state === 'writing');
    expect(stream.events.filter((e) => e.event === 'review')).toHaveLength(1);
  } finally { await stream.close(); }
});

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
test.skipIf(!browser)('only a passing full lint validates the requested walkthrough under the writing screen', async () => {
  expect((await cli(prArgs)).code).toBe(0);
  fs.writeFileSync(path.join(dir, REPORT_FILE), '<!doctype html><html><head><script type="module" src="/_rr/reviewroom.js"></script></head><body><rr-app><rr-review><section id="summary">Summary</section></rr-review></rr-app></body></html>');
  fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), JSON.stringify({ version: 1, title: 'Change the value', chapters: [
    { id: 'change', title: 'Change the value', steps: [{ id: 'value', text: '<p>The value changes from one to two.</p>', ref: 'rr:code/example.ts#L1' }] },
  ] }));
  const log = path.join(dir, 'progress.jsonl');
  const scoped = await cli(['slide-lint', ...d, '--slide', 'change/value']);
  expect(scoped.code).toBe(0);
  expect(progressLines(dir).filter((l) => l.artifact === 'walkthrough' && l.event === 'validated')).toHaveLength(0);
  const full = await cli(['slide-lint', ...d]);
  expect([full.code, full.stderr]).toEqual([0, '']);
  expect(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)!)).toMatchObject({ artifact: 'walkthrough', event: 'validated', slides: 1, chapters: 1 });
}, 30_000);

test('--force --no-agent resets the old generation to idle; a server start stops pending assistant work as interrupted, never an agent\'s', async () => {
  const log = path.join(dir, 'progress.jsonl');
  // the log keeps the earlier tests' requests and validations: --no-agent must not carry them over
  expect(progressLines(dir).some((l) => l.event === 'requested')).toBe(true);
  const requestsBefore = progressLines(dir).filter((l) => l.event === 'requested').length;
  await cli(['stop', ...d]); // pr leaves a running review as it is
  expect((await cli([...prArgs, '--force', '--no-agent'])).code).toBe(0);
  expect(progressLines(dir).filter((l) => l.event === 'requested')).toHaveLength(requestsBefore);
  const url = (await cli(prArgs)).stdout.trim();
  expect(await fetch(url + 'api/progress').then((r) => r.json())).toEqual({ walkthrough: { state: 'idle' }, report: { state: 'idle' } });
  // through the hub, the hub's refusal comes first; without the assistant, generate says why
  const viaHub = await fetch(url + 'api/generate', { method: 'POST', headers: { 'x-reviewroom-via-hub': '1' } });
  expect([viaHub.status, (await viaHub.json()).code]).toEqual([403, 'via_hub']);
  const generate = await fetch(url + 'api/generate', { method: 'POST' });
  expect([generate.status, (await generate.json()).code]).toEqual([409, 'assistant_off']);
  expect((await fetch(url + 'api/meta').then((r) => r.json())).generate).toBeUndefined();
  // a generation the previous server was running (the assistant's walkthrough), and an agent's report
  const at = new Date().toISOString();
  fs.appendFileSync(log, [{ at, artifact: 'walkthrough', event: 'requested', by: 'assistant', id: 'a1' }, { at, artifact: 'report', event: 'requested', by: 'agent', id: 'g1' }].map((l) => JSON.stringify(l) + '\n').join(''));
  await cli(['stop', ...d]);
  const next = (await cli(prArgs)).stdout.trim();
  const progress = await fetch(next + 'api/progress').then((r) => r.json());
  expect([progress.walkthrough.state, progress.walkthrough.reason, progress.report.state]).toEqual(['stopped', 'interrupted', 'requested']);
  expect(progressLines(dir).filter((l) => l.event === 'stopped')).toHaveLength(1);
});

test('a failed setup writes no config.json: a re-run keeps the old one, a new folder gets none (no playable row)', async () => {
  await cli(['stop', ...d]); // pr leaves a running review as it is
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  expect((await cli(['pr', ...d, '--base', 'no-such-ref', '--no-serve'])).code).not.toBe(0);
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  const fresh = path.join(tmp, 'home', 'reviews', 'repo', 'never-set-up');
  expect((await cli(['pr', 'never-set-up', '--head', 'feature', '--base', 'no-such-ref', '--no-serve', '--repo', repo])).code).not.toBe(0);
  expect(fs.existsSync(path.join(fresh, 'config.json'))).toBe(false);
});
