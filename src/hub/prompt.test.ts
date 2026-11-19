import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { ownAgentPrompt, shellQuote } from './prompt';

test('the own-agent prompt shell-quotes the target and the repository path', async () => {
  expect(ownAgentPrompt('acme/demo#7', '/Users/me/src/demo')).toBe(
    "Review acme/demo#7 with reviewroom: run `reviewroom pr 'acme/demo#7' --repo /Users/me/src/demo`, follow the reviewroom skill to write the walkthrough and report, then run `reviewroom wait 'acme/demo#7' --repo /Users/me/src/demo`.");
  // what the shell reads back is the value itself
  for (const s of ["/Users/me/My Repos/it's $HOME; rm -rf ~", 'feat/a b`x`', '', '--x']) expect((await $`sh -c ${`printf %s ${shellQuote(s)}`}`.text())).toBe(s);
});
