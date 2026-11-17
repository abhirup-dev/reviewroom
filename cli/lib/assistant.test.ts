import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UIMessage } from 'ai';
import { assistantLaunch, assistantRoutes, instructions, readAssistantSettings, withContext } from './assistant.ts';
import { LINK_IN_TEXT, parseRef } from '../../src/kernel/refs/refs.shared.ts';
import { PKG } from './paths.ts';

const revs = { base: 'b0', head: 'h0' };
const settings = { defaultAgentHarness: 'claude' as const, defaultReviewModel: 'sonnet', reviewAgentPromptFile: path.join(PKG, 'templates/assistant-prompt.md') };
const quote = { text: 'return x;', messageId: '', ref: 'rr:code/src/a.ts#L4-6', label: 'src/a.ts:4-6' };
const user = (text: string, metadata?: unknown): UIMessage => ({ id: text, role: 'user', parts: [{ type: 'text', text }], metadata });

test('machine settings default when absent and accept a model alongside existing settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-settings-'));
  const file = path.join(dir, 'config.json');
  try {
    const defaultPrompt = path.join(PKG, 'templates/assistant-prompt.md');
    expect(readAssistantSettings(file)).toEqual({ defaultAgentHarness: 'claude', defaultReviewModel: 'sonnet', reviewAgentPromptFile: defaultPrompt });
    const existing = '{"publicOrigin":"https://review.example","defaultReviewModel":"claude-custom-model"}';
    fs.writeFileSync(file, existing);
    expect(readAssistantSettings(file)).toEqual({ defaultAgentHarness: 'claude', defaultReviewModel: 'claude-custom-model', reviewAgentPromptFile: defaultPrompt });
    expect(fs.readFileSync(file, 'utf8')).toBe(existing);
    for (const invalid of ['{', '{"defaultAgentHarness":"codex"}', '{"defaultReviewModel":" "}']) {
      fs.writeFileSync(file, invalid);
      expect(() => readAssistantSettings(file)).toThrow(`Invalid assistant settings in ${file}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a configured prompt resolves beside settings and replaces the default while retaining review context and skill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-assistant-prompt-'));
  const file = path.join(dir, 'config.json');
  const prompt = path.join(dir, 'review-agent.md');
  try {
    fs.writeFileSync(file, JSON.stringify({ reviewAgentPromptFile: 'review-agent.md' }));
    fs.writeFileSync(prompt, 'Explain tradeoffs first. Keep {{literal}} unchanged.');
    expect(readAssistantSettings(file).reviewAgentPromptFile).toBe(prompt);
    const text = instructions('repository', 'review-directory', { base: 'base-sha', head: 'head-sha' }, readAssistantSettings(file).reviewAgentPromptFile);
    expect(text).toStartWith('Explain tradeoffs first. Keep {{literal}} unchanged.');
    expect(text).not.toContain('You are the assistant beside');
    expect(text).toContain('base-sha..head-sha of repository');
    expect(text).toContain('review-directory/review.html');
    expect(text).toContain(fs.readFileSync(path.join(PKG, 'skills/reviewroom/SKILL.md'), 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ reviewAgentPromptFile: prompt }));
    expect(readAssistantSettings(file).reviewAgentPromptFile).toBe(prompt);
    fs.writeFileSync(prompt, '  ');
    expect(() => instructions('r', 'd', { base: 'b', head: 'h' }, prompt)).toThrow('prompt file is empty');
    expect(() => instructions('r', 'd', { base: 'b', head: 'h' }, path.join(dir, 'missing.md'))).toThrow('missing.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new question carries its attached context, once, before the question', () => {
  const earlier = user('first', { custom: { quote } });
  const out = withContext([earlier, { id: 'a', role: 'assistant', parts: [] }, user('why?', { custom: { quote } })], revs);
  expect(out[0]).toBe(earlier); // history the native session already has is not repeated
  const parts = out.at(-1)!.parts as { text: string }[];
  expect(parts.map((p) => p.text)).toEqual([expect.stringContaining('rr:code/src/a.ts#L4-6 (head = h0)'), 'why?']);
});

test('an approval continuation and a plain question are left as they are', () => {
  const continuation = [user('do it', { custom: { quote } }), { id: 'a', role: 'assistant' as const, parts: [] }];
  expect(withContext(continuation, revs)).toBe(continuation);
  const plain = [user('hi')];
  expect(withContext(plain, revs)).toBe(plain);
});

test('a question with an invalid context is refused', async () => {
  const { app } = assistantRoutes({ repo: '.', dir: '.', cfg: { base: 'main', head: 'HEAD' }, settings });
  const bad = user('x', { custom: { quote: { ...quote, ref: 'rr:thread/t1' } } });
  const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'submit-message', messages: [bad] }) });
  expect(res.status).toBe(400);
});

test('every link the agent is shown as an example is one Review Room opens', () => {
  const links = instructions('repo', 'dir', { base: 'main', head: 'HEAD' }).split('The Review Room skill follows')[0].match(LINK_IN_TEXT)!;
  expect(links.map((l) => parseRef(l)?.type)).toEqual(['code', 'code', 'sym', 'doc']);
  expect(parseRef(links[1])).toMatchObject({ rev: 'base', start: 8 });
});

test('the assistant takes only new messages: the native session cannot branch', async () => {
  const { app } = assistantRoutes({ repo: '.', dir: '.', cfg: { base: 'main', head: 'HEAD' }, settings });
  const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trigger: 'regenerate-message', messages: [] }) });
  expect(res.status).toBe(400);
});

// This runs a real child: subscription overrides and PATH changes must not leak back into the review server.
test('Bun bridge launch clears only child auth overrides and preserves host PATH', async () => {
  const before = process.env.PATH;
  const script = 'console.log(JSON.stringify({key:process.env.ANTHROPIC_API_KEY??null,path:process.env.PATH}))';
  const child = Bun.spawn(['sh', '-c', assistantLaunch(`node -e '${script}'`)], { env: { ...process.env, ANTHROPIC_API_KEY: 'probe-not-a-real-key' }, stdout: 'pipe', stderr: 'pipe' });
  const out = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(out.key).toBeNull();
  expect(out.path).toBe(before);
  expect(process.env.PATH).toBe(before);
});
