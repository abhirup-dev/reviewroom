// A scripted stand-in for Claude (the server loads it by REVIEWROOM_TEST_ASSISTANT): streams like the real one, so a
// page can follow a turn it didn't start. A generation turn says it is reading, then waits for the test's `go-1`
// (REVIEWROOM_TEST_GATES), writes and validates the walkthrough, waits for `go-2`, then the report. A question is
// answered at once.
import fs from 'node:fs';
import path from 'node:path';
import { streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { recordArtifact } from '../cli/lib/progress.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const gate = async (name: string) => {
  const file = path.join(process.env.REVIEWROOM_TEST_GATES!, name);
  while (!fs.existsSync(file)) await Bun.sleep(50);
};
type Prompt = { role: string; content: unknown }[];
const lastText = (prompt: Prompt) => {
  const last = prompt.findLast((m) => m.role === 'user');
  return last && Array.isArray(last.content) ? last.content.map((p: { text?: string }) => p.text ?? '').join('') : '';
};

async function run(c: ReadableStreamDefaultController<object>, prompt: Prompt, dir: string) {
  let n = 0;
  const say = (text: string) => {
    const id = `t${n++}`;
    c.enqueue({ type: 'text-start', id });
    c.enqueue({ type: 'text-delta', id, delta: text });
    c.enqueue({ type: 'text-end', id });
  };
  const write = (artifact: 'walkthrough' | 'report', file: string) => {
    fs.copyFileSync(path.join(import.meta.dir, `../examples/uploads/${file}`), path.join(dir, file));
    recordArtifact(dir, artifact, 'validated');
  };
  c.enqueue({ type: 'stream-start', warnings: [] });
  const asked = lastText(prompt);
  if (asked.includes('walkthrough and report now')) {
    say('Reading the diff.');
    await gate('go-1');
    write('walkthrough', WALKTHROUGH_FILE);
    say('The walkthrough passes. Writing the report.');
    await gate('go-2');
    write('report', REPORT_FILE);
    say('Both pass.');
  } else say(`You asked: ${asked}`);
  c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
  c.close();
}

export function launch({ dir }: { dir: string }) {
  const model = new MockLanguageModelV4({
    // detached: a stream's chunks can't be read until its start() returns
    doStream: async ({ prompt }) => ({ stream: new ReadableStream({ start: (c) => void run(c, prompt, dir) }) as never }),
  });
  return Promise.resolve({
    agent: { stream: (o: { messages: never; abortSignal: AbortSignal }) => streamText({ model, messages: o.messages, abortSignal: o.abortSignal }) },
    session: { hasUnfinishedTurn: () => false },
    checkpoint: async () => {},
    stop: async () => {},
  } as never);
}
