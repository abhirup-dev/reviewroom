// Required targets and command argument parsing.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { StoredThread } from '../src/kernel/state/schema.shared.ts';
import { setup } from './fixture.ts';

describe('cli', () => {
  const { repo, dir, d, cli, state } = setup();
  let thread = '';
  beforeAll(async () => (thread = (await cli(['comment', ...d, 'general', 'why?'])).stdout.trim()));

  test('reply --resolve without a body resolves the thread', async () => {
    expect((await cli(['reply', ...d, thread, '--resolve'])).code).toBe(0);
    expect(state().threads.find((t: StoredThread) => t.id === thread).status).toBe('resolved');
  });
  test('a path target finds its saved repository', async () => expect(await cli(['check', dir])).toMatchObject({ code: 0, stderr: '' }));
  test('help never shows a negated flag as "(default: true)"', async () => {
    const help = (await cli(['pr', '--help'])).stdout;
    expect(help).toContain('--no-serve');
    expect(help).not.toContain('(default: true)');
  });
  test('pr with an unknown report profile fails and names the profiles', async () => {
    const r = await cli(['pr', 'feat/upload-rate-limit', '--base', 'main', '--head', 'feat/upload-rate-limit', '--profile', 'nope', '--no-open', '--repo', repo]);
    expect([r.code, r.stdout]).toEqual([1, expect.stringContaining('no report profile "nope" (profiles: explainer')]);
  });
  test.each(['pr', 'start', 'wait', 'status', 'stop', 'reply', 'comment', 'check', 'slide-lint', 'shot', 'publish-slides'])('%s requires a review', async (command) => {
    expect(await cli([command, '--repo', repo])).toMatchObject({ code: 2, stdout: expect.stringContaining('missing review') });
  });
  test.each([
    ['check', dir, '--dir', dir],
    ['pr', dir, '--detach'],
    ['pr', dir, '--wait'],
    ['wait', dir, '--forever'],
    ['hub', '--stop'],
    ['review', dir],
    ['status', dir, 'extra'],
    ['list', dir],
    ['hub', 'stop', 'extra'],
    ['shot', '3'],
  ].map((args) => ({ args })))('rejects removed flags or extra arguments: %j', async ({ args }) => {
    expect((await cli(args)).code).not.toBe(0);
  });

});
