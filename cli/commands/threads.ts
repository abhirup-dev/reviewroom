// status --threads / reply / comment: the agent's side of the conversation, written as ops
import fs from 'node:fs';
import { type Global, fail } from '../lib/args.ts';
import { dirForEdit } from '../lib/config.ts';
import { readState, commitOps, uid, validWalkthrough } from '../lib/state.ts';
import { anchorText, githubContext } from '../../src/shared/feedback.ts';
import { anchorOf, anchorRef } from '../../src/shared/refs.ts';
import { cachedThreads } from '../lib/github.ts';
import type { ReviewState } from '../../src/core/types.ts';
import { issueText, type Op } from '../../src/shared/schema.ts';
import { z } from 'zod';

function findThread(s: ReviewState, id: string) {
  if (id.startsWith('gh_')) fail(`${id} is a GitHub thread: only the reviewer posts there. Link it with rr:thread/${id} in review.html or your reply instead.`);
  const t = s.threads.find((x) => x.id === id) || s.threads.filter((x) => x.id.startsWith(id) || x.id === 't_' + id)[0];
  if (!t) fail(`no thread ${id}`);
  return t;
}
type BodyOpts = Global & { file?: string };
/** The message: --file, else the body argument, else stdin (`-`, or piped with no argument). */
function readBody(file: string | undefined, arg: string | undefined) {
  const b = file ? fs.readFileSync(file, 'utf8') : arg === '-' || (!arg && !process.stdin.isTTY) ? fs.readFileSync(0, 'utf8') : arg;
  if (!b?.trim()) fail('missing message body');
  return b.trim();
}

export function cmdThreads(repo: string | null, o: Global & { all?: boolean; json?: boolean }) {
  const dir = dirForEdit(repo, o.dir);
  const s = readState(dir);
  const list = s.threads.filter((t) => o.all || t.status === 'open');
  const github = cachedThreads(dir).filter((t) => o.all || t.status === 'open');
  if (o.json) {
    console.log(JSON.stringify({ round: s.round, threads: list, github }, null, 2));
    return;
  }
  const walkthrough = validWalkthrough(dir);
  console.log(`round ${s.round} | ${list.length} ${o.all ? '' : 'open '}thread(s)`);
  for (const t of list) {
    const last = t.messages[t.messages.length - 1];
    console.log(`\n${t.id}  [${t.status}]  ${anchorText(t.anchor, walkthrough)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
    for (const m of t.messages) console.log(`  ${m.author}@r${m.round}: ${m.body.split('\n').join('\n    ')}`);
    if (last?.author === 'you') console.log('  -> awaiting agent reply');
  }
  if (github.length) console.log('\n' + githubContext(github).join('\n'));
}

// Agent replies as ops: `reply <thread> "<md>"`, or `reply --json <file|->` with [{thread, body, resolve?}].
const Replies = z.array(z.object({ thread: z.string(), body: z.string().trim().min(1), resolve: z.boolean().optional() })).min(1);
function replyOps(s: ReviewState, input: unknown) {
  const r = Replies.safeParse(input);
  if (!r.success) fail(`replies are a non-empty array of {thread, body, resolve?}: ${issueText(r.error)}`);
  return r.data.flatMap((it) => {
    const t = findThread(s, it.thread);
    const ops: Op[] = [{ op: 'addMessage', threadId: t.id, id: uid('m_'), body: it.body, author: 'agent' }];
    if (it.resolve) ops.push({ op: 'setThreadStatus', threadId: t.id, status: 'resolved' });
    return ops;
  });
}

export async function cmdReply(repo: string | null, o: BodyOpts & { resolve?: boolean; json?: string | true }, [thread, body]: string[]) {
  const dir = dirForEdit(repo, o.dir);
  let items: unknown;
  if (o.json) {
    // `--json file`, `--json -`, or `--json` alone (stdin); cac may leave the file as the first argument
    const src = typeof o.json === 'string' ? o.json : (thread ?? '-');
    try {
      items = JSON.parse(fs.readFileSync(src === '-' ? 0 : src, 'utf8'));
    } catch (e) {
      fail(`--json: ${(e as Error).message}`);
    }
  } else if (!thread) fail('missing thread id');
  else if (o.resolve && body === undefined && !o.file) {
    // `reply <thread> --resolve` without a body: resolve only
    const t = findThread(readState(dir), thread);
    await commitOps(dir, [{ op: 'setThreadStatus', threadId: t.id, status: 'resolved' }]);
    return console.log(`resolved ${t.id}`);
  } else items = [{ thread, body: readBody(o.file, body), resolve: o.resolve }];
  const ops = replyOps(readState(dir), items);
  await commitOps(dir, ops);
  if (o.json) console.log(`replied to ${ops.filter((x) => x.op === 'addMessage').length} thread(s)`);
  else console.log(`replied to ${(ops[0] as Extract<Op, { op: 'addMessage' }>).threadId}${o.resolve ? ' (resolved)' : ''}`);
}

export async function cmdComment(repo: string | null, o: BodyOpts, [ref, body]: string[]) {
  const dir = dirForEdit(repo, o.dir);
  if (!ref) fail('missing rr: ref (or "general")');
  const id = uid('t_');
  await commitOps(dir, [{ op: 'createThread', id, anchor: anchorOf(ref), msgId: uid('m_'), body: readBody(o.file, body), author: 'agent' }]);
  console.log(id);
}
