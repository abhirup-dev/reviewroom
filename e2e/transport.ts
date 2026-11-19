import { expect } from 'bun:test';
import { $ } from 'bun';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionInfo } from '../src/hub/model.shared.ts';
import { until } from '../src/testing/wait.ts';

const entry = path.resolve(import.meta.dir, '../dist/cli/reviewroom.js');
const bun = process.execPath; // the CLI runs on the same Bun as the tests
type CliEnv = Record<string, string | undefined>;
export const runCli = async (env: CliEnv, args: string[], input = '') => {
  const r = await $`${bun} ${entry} ${args} < ${new Response(input)}`.env(env).nothrow().quiet();
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
export const spawnCli = (env: CliEnv, args: string[], cwd?: string) =>
  Bun.spawn([bun, entry, ...args], { env, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });

export const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
export const readJson = (...p: string[]) => JSON.parse(read(...p));
export const config = (dir: string) => readJson(dir, 'config.json');

export function hubClient(cli: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  let url = '';
  return {
    async start(args: string[] = []) {
      const result = await cli(['hub', 'serve', '--detach', '--no-open', '--port', '0', ...args]);
      if (result.code) throw new Error(result.stderr);
      url = result.stdout.trim();
      return url;
    },
    sessions: async () => (await (await fetch(url + 'api/sessions')).json()).sessions as SessionInfo[],
    post: (p: string, action: string, body?: object) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-reviewroom-action': action }, body: body && JSON.stringify(body) }),
    stop: () => cli(['hub', 'stop']),
  };
}

export async function reviewEvents(url: string) {
  const abort = new AbortController();
  const response = await fetch(url + 'api/events', { signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: string }[] = [];
  let failure: unknown;
  const reading = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('review event stream closed');
      buffer += value;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const [name, data] = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        if (name.startsWith('event: ')) events.push({ event: name.slice('event: '.length), data: data?.slice('data: '.length) ?? '' });
      }
    }
  })().catch((e: unknown) => { if (!abort.signal.aborted) failure = e; });
  return {
    events,
    async find(name: string, text = '') {
      const result = await until(() => failure ? { failure } : events.find((event) => event.event === name && event.data.includes(text)));
      if ('failure' in result) throw result.failure;
      return result;
    },
    async close() {
      abort.abort();
      await reading;
      if (failure) throw failure;
    },
  };
}
