import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { $ } from 'bun';
import { until } from '../src/testing/wait.ts';
import { progressLines } from '../cli/lib/progress.ts';

// A tiny independent repository: this contract must not depend on demo content.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-progress-e2e-'));
const repo = path.join(tmp, 'repo'), dir = path.join(tmp, 'review');
const env = { ...process.env, REVIEWROOM_HOME: path.join(tmp, 'home') };
const entry = path.resolve(import.meta.dir, '../dist/cli/reviewroom.js');
const d = ['--repo', repo, '--dir', dir];
const cli = async (args: string[]) => {
  const r = await $`${process.execPath} ${entry} ${args}`.env(env).quiet().nothrow();
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
afterAll(async () => {
  await cli(['stop', ...d]);
  await cli(['hub', '--stop']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
fs.mkdirSync(repo);
await $`git -C ${repo} init -b main`.quiet();
await $`git -C ${repo} config user.name Fixture`.quiet();
await $`git -C ${repo} config user.email fixture@example.invalid`.quiet();
fs.writeFileSync(path.join(repo, 'example.ts'), 'export const value = 1;\n');
await $`git -C ${repo} add .`.quiet();
await $`git -C ${repo} commit -m initial`.quiet();
await $`git -C ${repo} checkout -b feature`.quiet();
fs.writeFileSync(path.join(repo, 'example.ts'), 'export const value = 2;\n');
await $`git -C ${repo} commit -am update`.quiet();
const prArgs = ['pr', 'feature', '--base', 'main', '--detach', '--no-open', '--port', '0', ...d];
test('pr requests only on creation/force; watcher pushes progress without reload until check passes', async () => {
  const initial = await cli([...prArgs, '--force']);
  expect(initial.code).toBe(0);

  const requested = progressLines(dir).filter((l) => l.event === 'requested');
  expect(requested.map((l) => [l.artifact, 'by' in l && l.by])).toEqual([['walkthrough', 'agent'], ['report', 'agent']]);
  const url = (await cli(prArgs)).stdout.trim();
  expect(progressLines(dir).filter((l) => l.event === 'requested')).toEqual(requested);
  const abort = new AbortController();
  const events: { event: string; data: string }[] = [];
  const response = await fetch(url + 'api/events', { signal: abort.signal });
  const reader = response.body!.getReader();
  const reading = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        events.push({ event: block.match(/event: (.*)/)?.[1] ?? '', data: block.match(/data: (.*)/)?.[1] ?? '' });
      }
    }
  })().catch(() => {});
  try {
    await until(() => events.some((e) => e.event === 'hello'));
    for (const text of ['<rr-app><rr-review>', '<rr-app><rr-review><section id="summary"><h1>Summary</h1></section></rr-review></rr-app>']) {
      fs.writeFileSync(path.join(dir, REPORT_FILE), text);
      await until(async () => (await fetch(url + 'api/progress').then((r) => r.json())).report.state === 'writing');
    }
    expect(events.filter((e) => e.event === 'review')).toHaveLength(0);
    expect((await cli(['check', ...d])).code).toBe(0);
    await until(() => events.filter((e) => e.event === 'review').length === 1);
    expect((await fetch(url + 'api/progress').then((r) => r.json())).report.state).toBe('validated');
    // the same bytes saved again: the watcher fires, but the state did not change, so pages get no progress event
    const progressEvents = () => events.filter((e) => e.event === 'progress').length;
    const sent = progressEvents();
    fs.writeFileSync(path.join(dir, REPORT_FILE), fs.readFileSync(path.join(dir, REPORT_FILE)));
    await Bun.sleep(600);
    expect(progressEvents()).toBe(sent);
    fs.appendFileSync(path.join(dir, REPORT_FILE), '<!-- another save -->');
    await until(async () => (await fetch(url + 'api/progress').then((r) => r.json())).report.state === 'writing');
    expect(events.filter((e) => e.event === 'review')).toHaveLength(1);
  } finally { abort.abort(); await reading; }
});

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
test.skipIf(!browser)('only a passing full lint validates the requested walkthrough under the writing screen', async () => {
  expect((await cli(prArgs)).code).toBe(0);
  fs.writeFileSync(path.join(dir, REPORT_FILE), '<!doctype html><html><head><script type="module" src="/_rr/reviewroom.js"></script></head><body><rr-app><rr-review><section id="summary">Summary</section></rr-review></rr-app></body></html>');
  fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), JSON.stringify({ version: 1, title: 'Change the value', chapters: [
    { id: 'change', title: 'Change the value', steps: [{ id: 'value', text: '<p>The value changes from one to two.</p>', ref: 'rr:code/example.ts#L1' }] },
  ] }));
  const log = path.join(dir, 'progress.jsonl');
  const scoped = await cli(['slide-lint', '--slide', 'change/value', ...d]);
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
  const next = (await cli(prArgs)).stdout.trim(); // takes the server over
  const progress = await fetch(next + 'api/progress').then((r) => r.json());
  expect([progress.walkthrough.state, progress.walkthrough.reason, progress.report.state]).toEqual(['stopped', 'interrupted', 'requested']);
  expect(progressLines(dir).filter((l) => l.event === 'stopped')).toHaveLength(1);
});

test('--force resets only once the previous server has stopped: it can no longer accept a generation in between', async () => {
  const old = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')).pid as number;
  const running = cli([...prArgs, '--force', '--no-agent']);
  let gone = 0;
  while (!gone) {
    try {
      process.kill(old, 0);
      await new Promise((r) => setTimeout(r, 5));
    } catch {
      gone = Date.now();
    }
  }
  expect((await running).code).toBe(0);
  const reset = progressLines(dir).filter((l) => l.event === 'reset').at(-1)!;
  expect(Date.parse(reset.at)).toBeGreaterThanOrEqual(gone - 10); // the 5 ms poll's slack
});

test('a --force takeover keeps the old server\'s port (an open tab reconnects)', async () => {
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')) as { pid: number; port: number };
  const r = await cli(prArgs.filter((a, i) => a !== '--port' && prArgs[i - 1] !== '--port').concat('--force', '--no-agent'));
  expect(r.code).toBe(0);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')) as { pid: number; port: number };
  expect([after.pid !== before.pid, after.port]).toEqual([true, before.port]);
});
