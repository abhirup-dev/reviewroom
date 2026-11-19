// The one stand-in for Claude, shaped like the harness's `Live` (cli/lib/assistant.ts): launched once and reused, a
// start that can wait or fail, a session that can hold its turn on an approval, a checkpoint, a stop. Turns stream
// through AI SDK's real streamText on a mock model, so routes and pages follow them as they would Claude's.
// The server loads `launch` by REVIEWROOM_TEST_ASSISTANT (e2e): a generation says it is reading, then waits for the
// test's `go-1` (REVIEWROOM_TEST_GATES), saves the walkthrough's outline, writes and validates it, waits for `go-2`, then the report. A
// question is answered at once. Unit tests make their own with `fakeAgent`.
import fs from 'node:fs';
import path from 'node:path';
import { streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { recordArtifact } from '../cli/lib/progress.ts';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Prompt = { role: string; content: unknown }[];
const lastText = (prompt: Prompt) => {
  const last = prompt.findLast((m) => m.role === 'user');
  return last && Array.isArray(last.content) ? last.content.map((p: { text?: string }) => p.text ?? '').join('') : '';
};
/** A turn: says things, and returns to finish (or never returns: it runs until it is stopped). */
type Script = (turn: { say: (text: string) => void; asked: string; dir: string }) => Promise<void>;

/** `starting`: Claude still starting (or failing to); `held`: the session keeps its last turn on an approval. */
export function fakeAgent(script: Script, { starting, held = () => false }: { starting?: Promise<void>; held?: () => boolean } = {}) {
  const calls = { launched: 0, stopped: 0 };
  const run = async (c: ReadableStreamDefaultController<object>, prompt: Prompt, dir: string) => {
    let n = 0;
    c.enqueue({ type: 'stream-start', warnings: [] });
    const say = (text: string) => {
      const id = `t${n++}`;
      c.enqueue({ type: 'text-start', id });
      c.enqueue({ type: 'text-delta', id, delta: text });
      c.enqueue({ type: 'text-end', id });
    };
    await script({ say, asked: lastText(prompt), dir });
    c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
    c.close();
  };
  const launch = async ({ dir }: { dir: string }) => {
    calls.launched++;
    await starting;
    const model = new MockLanguageModelV4({
      // detached: a stream's chunks can't be read until its start() returns
      doStream: async ({ prompt }) => ({ stream: new ReadableStream({ start: (c) => void run(c, prompt, dir) }) as never }),
    });
    return {
      agent: { stream: (o: { messages: never; abortSignal: AbortSignal }) => streamText({ model, messages: o.messages, abortSignal: o.abortSignal }) },
      session: { hasUnfinishedTurn: held },
      checkpoint: async () => {},
      stop: async () => void calls.stopped++,
    } as never;
  };
  return { launch, calls };
}

const gate = async (name: string) => {
  const file = path.join(process.env.REVIEWROOM_TEST_GATES!, name);
  while (!fs.existsSync(file)) await Bun.sleep(50);
};
const write = (dir: string, artifact: 'walkthrough' | 'report', file: string) => {
  fs.copyFileSync(path.join(import.meta.dir, `../examples/uploads/${file}`), path.join(dir, file));
  recordArtifact(dir, artifact, 'validated');
};

/** The walkthrough's outline (SKILL.md Step 4): its chapters and slides, one line each. A save, never checked. */
const outline = (dir: string) => {
  const w = JSON.parse(fs.readFileSync(path.join(import.meta.dir, `../examples/uploads/${WALKTHROUGH_FILE}`), 'utf8'));
  const chapters = w.chapters.map((c: { id: string; title: string; steps: { id: string }[] }) => ({ id: c.id, title: c.title, steps: c.steps.map((s) => ({ id: s.id, text: `<p>${s.id}</p>` })) }));
  fs.writeFileSync(path.join(dir, WALKTHROUGH_FILE), JSON.stringify({ ...w, chapters }));
  recordArtifact(dir, 'walkthrough', 'written');
};

export const { launch } = fakeAgent(async ({ say, asked, dir }) => {
  if (!asked.startsWith('Write only the following requested review artifacts')) return say(`You asked: ${asked}`);
  say('Reading the diff.');
  await gate('go-1');
  outline(dir);
  write(dir, 'walkthrough', WALKTHROUGH_FILE);
  say('The walkthrough passes. Writing the report.');
  await gate('go-2');
  write(dir, 'report', REPORT_FILE);
  say('Both pass.');
});
