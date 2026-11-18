import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { ownAgentPrompt, shellQuote } from './prompt';

test('the own-agent prompt shell-quotes the target and the repository path', async () => {
  expect(ownAgentPrompt('https://github.com/acme/demo/pull/7', '/Users/me/src/demo')).toBe(
    'Review https://github.com/acme/demo/pull/7 with reviewroom: run `reviewroom pr https://github.com/acme/demo/pull/7 --repo /Users/me/src/demo --wait` and follow the reviewroom skill.');
  // what the shell reads back is the value itself
  for (const s of ["/Users/me/My Repos/it's $HOME; rm -rf ~", 'feat/a b`x`', '', '--x']) expect((await $`sh -c ${`printf %s ${shellQuote(s)}`}`.text())).toBe(s);
});
