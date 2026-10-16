// status --threads / reply / comment: the agent's side of the conversation, written as ops
import fs from 'node:fs';
import { type Opts, die } from '../lib/args.ts';
import { dirForEdit, readState, commitOps, uid } from '../lib/state.ts';
import { anchorText, githubContext } from '../../src/shared/feedback.ts';
import { anchorOf, anchorRef } from '../../src/shared/refs.ts';
import { cachedThreads } from '../lib/github.ts';
import type { ReviewState } from '../../src/core/types.ts';
import type { Op } from '../../src/shared/schema.ts';

function threadArg(pos: string[]) {
  const id = pos.shift();
  if (!id) die('missing thread id');
  return id;
}
function findThread(s: ReviewState, id: string) {
  if (id.startsWith('gh_')) die(`${id} is a GitHub thread: only the reviewer posts there. Link it with rr:thread/${id} in review.html or your reply instead.`);
  const t = s.threads.find((x) => x.id === id) || s.threads.filter((x) => x.id.startsWith(id) || x.id === 't_' + id)[0];
  if (!t) die(`no thread ${id}`);
  return t;
}
function readBody(o: Opts, pos: string[]) {
  let b = pos.shift();
  if (typeof o.file === 'string') b = fs.readFileSync(o.file, 'utf8');
  else if (b === '-' || (!b && !process.stdin.isTTY)) b = fs.readFileSync(0, 'utf8');
  if (!b?.trim()) die('missing message body');
  return b.trim();
}

export function cmdThreads(repo: string | null, o: Opts) {
  const dir = dirForEdit(repo, o.dir);
  const s = readState(dir);
  const list = s.threads.filter((t) => o.all || t.status === 'open');
  const github = cachedThreads(dir).filter((t) => o.all || t.status === 'open');
  if (o.json) {
    console.log(JSON.stringify({ round: s.round, threads: list, github }, null, 2));
    return;
  }
  console.log(`round ${s.round} · ${list.length} ${o.all ? '' : 'open '}thread(s)`);
  for (const t of list) {
    const last = t.messages[t.messages.length - 1];
    console.log(`\n${t.id}  [${t.status}]  ${anchorText(t.anchor)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
    for (const m of t.messages) console.log(`  ${m.author}@r${m.round}: ${m.body.split('\n').join('\n    ')}`);
    if (last?.author === 'you') console.log('  → awaiting agent reply');
  }
  if (github.length) console.log('\n' + githubContext(github).join('\n'));
}

// Agent replies as ops: `reply <thread> "<md>"`, or `reply --json <file|->` with [{thread, body, resolve?}].
type ReplyItem = { thread?: unknown; body?: unknown; resolve?: unknown };
function replyOps(s: ReviewState, items: ReplyItem[]) {
  return items.flatMap((it, i) => {
    if (typeof it?.thread !== 'string' || typeof it.body !== 'string' || !it.body.trim()) die(`reply ${i}: needs "thread" and a non-empty "body"`);
    const t = findThread(s, it.thread);
    const ops: Op[] = [{ op: 'addMessage', threadId: t.id, id: uid('m_'), body: it.body.trim(), author: 'agent' }];
    if (it.resolve) ops.push({ op: 'setThreadStatus', threadId: t.id, status: 'resolved' });
    return ops;
  });
}

export async function cmdReply(repo: string | null, o: Opts, pos: string[]) {
  const dir = dirForEdit(repo, o.dir);
  let items: ReplyItem[];
  if (o.json) {
    const src = typeof o.json === 'string' ? o.json : pos.shift() || '-';
    try {
      items = JSON.parse(fs.readFileSync(src === '-' ? 0 : src, 'utf8'));
    } catch (e) {
      die(`--json: ${(e as Error).message}`);
    }
    if (!Array.isArray(items) || !items.length) die('--json expects a non-empty array of {thread, body, resolve?}');
  } else if (o.resolve && pos.length === 1 && !o.file) {
    // `reply <thread> --resolve` without a body: resolve only
    const t = findThread(readState(dir), threadArg(pos));
    await commitOps(dir, [{ op: 'setThreadStatus', threadId: t.id, status: 'resolved' }]);
    return console.log(`resolved ${t.id}`);
  } else items = [{ thread: threadArg(pos), body: readBody(o, pos), resolve: o.resolve }];
  const ops = replyOps(readState(dir), items);
  await commitOps(dir, ops);
  if (o.json) console.log(`replied to ${items.length} thread(s)`);
  else console.log(`replied to ${(ops[0] as Extract<Op, { op: 'addMessage' }>).threadId}${o.resolve ? ' (resolved)' : ''}`);
}

export async function cmdComment(repo: string | null, o: Opts, pos: string[]) {
  const dir = dirForEdit(repo, o.dir);
  const ref = pos.shift() || die('missing rr: ref (or "general")');
  const id = uid('t_');
  await commitOps(dir, [{ op: 'createThread', id, anchor: anchorOf(ref), msgId: uid('m_'), body: readBody(o, pos), author: 'agent' }]);
  console.log(id);
}
