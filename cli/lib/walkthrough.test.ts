import { expect, test } from 'bun:test';
import { pickBlock } from './walkthrough.ts';

const block = (s: string) => '```reviewroom-walkthrough\n' + s + '\n```';
const msg = (body: string, login: string) => ({ body, gh: { login, url: `https://x/${login}` } });
const snap = (description: string, ...comments: ReturnType<typeof msg>[]) =>
  ({ description: { body: description }, threads: comments.length ? [{ gh: { conversation: true }, messages: comments }] : [] }) as unknown as Parameters<typeof pickBlock>[0];

test('the newest comment block wins, then the description; none is null', () => {
  expect(pickBlock(snap(block('desc')))).toEqual({ text: 'desc', from: 'the PR description' });
  expect(pickBlock(snap(block('desc'), msg(block('old'), 'a'), msg('no block', 'b'), msg(block('new'), 'c'), msg('later chat', 'd')))).toEqual({ text: 'new', from: 'PR comment by c (https://x/c)' });
  expect(pickBlock(snap('nothing', msg('chat', 'a')))).toBeNull();
});
