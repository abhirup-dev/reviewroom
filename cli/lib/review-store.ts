// Every file in a review folder, declared once: name, schema and write rule (docs/review-state.md).
// A json file that doesn't parse or breaks its schema is handled as its `bad` says:
//   aside  moved to <file>.corrupt-<time>; reads stay blocked until it is restored or deleted
//   throw  an error naming the file (hand-edited files)
//   skip   read as missing (caches and records that get rewritten)
import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';
import { REPORT_FILE, WALKTHROUGH_FILE } from '../../src/kernel/state/files.shared.ts';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { StoredState, issueText } from '../../src/kernel/state/schema.shared.ts';
import type { Snapshot } from './github.ts';

// config.json is hand-editable: a field of the wrong type is dropped, not trusted; unknown fields are kept.
// assistant: this review runs the built-in assistant, set by the hub's Play and `pr --assistant`, never by an external agent's `pr`.
const text = z.string().optional().catch(undefined);
export const ConfigFile = z.looseObject({ repoPath: text, base: text, head: text, title: text, remote: text, author: text, baseLabel: text, headLabel: text, profile: text, reportScaffoldHash: text, target: text, id: z.string().optional(), assistant: z.boolean().optional().catch(undefined) });
export type ConfigFile = z.infer<typeof ConfigFile>;

export const ServerRecord = z.object({ pid: z.number(), port: z.number(), url: z.string(), startedAt: z.string() });
export type ServerRecord = z.infer<typeof ServerRecord>;

const Closed = z.object({ at: z.string(), pid: z.number() });

export const LastLayout = z.object({ dock: z.looseObject({ grid: z.looseObject({}), panels: z.looseObject({}) }), offered: z.array(z.string()), layout: z.string().optional() });

const GitHubFile = z.custom<Snapshot>((v) => !!v && typeof v === 'object' && Array.isArray((v as { threads?: unknown }).threads));

export const SavedAssistant = z.object({
  version: z.literal(1),
  repo: z.string(),
  messages: z.array(z.custom<UIMessage>()),
  status: z.enum(['idle', 'working', 'interrupted', 'failed']).default('idle'),
  session: z.object({
    id: z.string(), sandboxId: z.string(),
    resume: z.custom<HarnessAgentResumeSessionState>(), // validated by the harness when resumed
  }).optional(),
});
export type SavedAssistant = z.infer<typeof SavedAssistant>;

const AssistantGroup = z.object({ pid: z.number().int().min(2), marker: z.string().regex(/^reviewroom-assistant-[0-9a-f-]{36}$/) });

type JsonSpec<T> = {
  kind: 'json'; name: string; schema: z.ZodType<T>; bad: 'aside' | 'throw' | 'skip';
  schemaName?: string;
  /** For a new file; an existing one keeps its own. */
  mode?: number;
  compact?: boolean;
  /** Keys the schema doesn't know survive a read, so an older reviewroom never drops a newer one's data. */
  keepUnknown?: boolean;
};
const json = <T>(name: string, schema: z.ZodType<T>, o: Omit<JsonSpec<T>, 'kind' | 'name' | 'schema'>): JsonSpec<T> => ({ kind: 'json', name, schema, ...o });

export const REVIEW_FILES = {
  config: json('config.json', ConfigFile, { bad: 'throw' }),
  state: json('state.json', StoredState, { bad: 'aside', schemaName: 'schema/state.schema.json', keepUnknown: true }),
  progress: { kind: 'log', name: 'progress.jsonl' },
  github: json('github.json', GitHubFile, { bad: 'skip' }),
  server: json('server.json', ServerRecord, { bad: 'skip', compact: true }),
  closed: json('closed.json', Closed, { bad: 'skip', compact: true }),
  layout: json('layout.json', LastLayout, { bad: 'skip', compact: true }),
  assistant: json('assistant.json', SavedAssistant, { bad: 'aside', schemaName: 'a saved assistant conversation', mode: 0o600, compact: true }),
  assistantProcess: json('assistant-process.json', AssistantGroup, { bad: 'skip', mode: 0o600, compact: true }),
  report: { kind: 'text', name: REPORT_FILE },
  walkthrough: { kind: 'text', name: WALKTHROUGH_FILE },
} as const;
const ROUNDS_DIR = 'rounds';
const LOCK_FILE = 'state.lock';
const SERVER_LOG = 'server.log';

// reviewroom's own files, with their temp and moved-aside copies (`<name>.*`), and the finished rounds. The agent's
// documents and assets are the only files a review serves.
const PRIVATE = [...Object.values(REVIEW_FILES).filter((f) => f.kind !== 'text').map((f) => f.name), LOCK_FILE, SERVER_LOG];
export function isPrivatePath(relative: string) {
  const parts = relative.toLowerCase().split('/').filter(Boolean).map((p) => p.replace(/^\./, ''));
  return parts[0] === ROUNDS_DIR || parts.some((p) => PRIVATE.some((name) => p === name || p.startsWith(`${name}.`)));
}

function writeAtomic(file: string, data: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic.sync(file, data, mode === undefined ? {} : { mode });
}

function readIfThere(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return null;
  }
}

const modifiedAt = (file: string): number | null => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;

// A copy moved aside means its data isn't gone: stay blocked rather than start over.
function readUnlessAside(file: string): string | null {
  const raw = readIfThere(file);
  if (raw !== null) return raw;
  const dir = path.dirname(file), name = path.basename(file);
  const aside = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`)) : [];
  if (aside.length) throw new ReviewroomError(`${file} was moved aside as ${aside.join(', ')}. Fix one and move it back as ${name}, or delete them all to start over.`);
  return null;
}

// `repair: false` (a read-only reader) never moves anything.
function moveAside(file: string, repair: boolean, why: string): never {
  if (!repair) throw new ReviewroomError(`${file} ${why}. Fix it or delete it to start over.`);
  const bad = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(file, bad);
  } catch {}
  throw new ReviewroomError(`${file} ${why}; moved it to ${bad}. Fix and move it back, or delete it to start over.`);
}

function jsonFile<T>(dir: string, spec: JsonSpec<T>) {
  const file = path.join(dir, spec.name);
  const bad = (why: string, repair: boolean): null => {
    if (spec.bad === 'skip') return null;
    if (spec.bad === 'aside') moveAside(file, repair, why);
    throw new ReviewroomError(`${file} ${why}; fix or delete it`);
  };
  const read = ({ repair = true } = {}): T | null => {
    const raw = spec.bad === 'aside' ? readUnlessAside(file) : readIfThere(file);
    if (raw === null) return null;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return bad(`is not valid JSON (${(e as Error).message})`, repair);
    }
    const checked = spec.schema.safeParse(data);
    if (!checked.success) return bad(`does not match ${spec.schemaName ?? 'its schema'} (${issueText(checked.error)})`, repair);
    return spec.keepUnknown ? { ...checked.data, ...(data as object) } : checked.data;
  };
  const write = (value: T) => writeAtomic(file, (spec.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n', spec.mode);
  return {
    file,
    exists: () => fs.existsSync(file),
    modifiedAt: () => modifiedAt(file),
    read,
    write,
    /** Not a lock: callers that race on the file serialize themselves (state.json: commitOps). */
    update(change: (current: T | null) => T) {
      const next = change(read());
      write(next);
      return next;
    },
    remove: () => fs.rmSync(file, { force: true }),
  };
}

function textFile(dir: string, name: string) {
  const file = path.join(dir, name);
  return {
    file,
    exists: () => fs.existsSync(file),
    modifiedAt: () => modifiedAt(file),
    read: () => readIfThere(file),
    bytes: (): Buffer | null => (fs.existsSync(file) ? fs.readFileSync(file) : null),
    write: (text: string) => writeAtomic(file, text),
  };
}

function logFile(dir: string, name: string) {
  const file = path.join(dir, name);
  return {
    file,
    read: () => readIfThere(file) ?? '',
    modifiedAt: () => modifiedAt(file),
    // A cut-off last line gets its newline first, so it stays alone and malformed instead of swallowing the first new one.
    append(lines: string) {
      let text = lines;
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0) {
        const fd = fs.openSync(file, 'r');
        const last = Buffer.alloc(1);
        try {
          fs.readSync(fd, last, 0, 1, size - 1);
        } finally {
          fs.closeSync(fd);
        }
        if (last[0] !== 0x0a) text = '\n' + text;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, text);
    },
  };
}

export function reviewStore(dir: string) {
  const f = REVIEW_FILES;
  return {
    dir,
    config: jsonFile(dir, f.config),
    state: jsonFile(dir, f.state),
    progress: logFile(dir, f.progress.name),
    github: jsonFile(dir, f.github),
    server: jsonFile(dir, f.server),
    closed: jsonFile(dir, f.closed),
    layout: jsonFile(dir, f.layout),
    assistant: jsonFile(dir, f.assistant),
    assistantProcess: jsonFile(dir, f.assistantProcess),
    report: textFile(dir, f.report.name),
    walkthrough: textFile(dir, f.walkthrough.name),
    round: (n: number) => {
      const rdir = path.join(dir, ROUNDS_DIR, String(n));
      return { report: textFile(rdir, REPORT_FILE), feedback: textFile(rdir, 'feedback.md') };
    },
    lockFile: path.join(dir, LOCK_FILE),
    serverLog: path.join(dir, SERVER_LOG),
  };
}
