// status --threads / reply / comment: the agent's side of the conversation, written as ops
import fs from 'node:fs';
import { flags, pos, die } from '../lib/args.mjs';
import { dirForEdit, readState, commitOps, uid, parseAnchor } from '../lib/state.mjs';
import { anchorText, anchorRef, githubContext } from '../../src/shared/feedback.ts';
import { cachedThreads } from '../lib/github.mjs';

function threadArg() {
  const id = pos.shift();
  if (!id) die('missing thread id');
  return id;
}
function findThread(s, id) {
  if (id.startsWith('gh_')) die(`${id} is a GitHub thread: only the reviewer posts there. Link it with rr:thread/${id} in review.html or your reply instead.`);
  const t = s.threads.find((x) => x.id === id) || s.threads.filter((x) => x.id.startsWith(id) || x.id === 't_' + id)[0];
  if (!t) die(`no thread ${id}`);
  return t;
}
function readBody() {
  let b = pos.shift();
  if (typeof flags.file === 'string') b = fs.readFileSync(flags.file, 'utf8');
  else if (b === '-' || (!b && !process.stdin.isTTY)) b = fs.readFileSync(0, 'utf8');
  if (!b?.trim()) die('missing message body');
  return b.trim();
}

export function cmdThreads(repo) {
  const dir = dirForEdit(repo);
  const s = readState(dir);
  const list = s.threads.filter((t) => flags.all || t.status === 'open');
  const github = cachedThreads(dir).filter((t) => flags.all || t.status === 'open');
  if (flags.json) {
    console.log(JSON.stringify({ round: s.round, threads: list, github }, null, 2));
    return;
  }
  console.log(`round ${s.round} · ${list.length} ${flags.all ? '' : 'open '}thread(s)`);
  for (const t of list) {
    const last = t.messages[t.messages.length - 1];
    console.log(`\n${t.id}  [${t.status}]  ${anchorText(t.anchor)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
    for (const m of t.messages) console.log(`  ${m.author}@r${m.round}: ${m.body.split('\n').join('\n    ')}`);
    if (last?.author === 'you') console.log('  → awaiting agent reply');
  }
  if (github.length) console.log('\n' + githubContext(github).join('\n'));
}

// Agent replies as ops: `reply <thread> "<md>"`, or `reply --json <file|->` with [{thread, body, resolve?}].
function replyOps(s, items) {
  return items.flatMap((it, i) => {
    if (typeof it?.thread !== 'string' || typeof it.body !== 'string' || !it.body.trim()) die(`reply ${i}: needs "thread" and a non-empty "body"`);
    const t = findThread(s, it.thread);
    const ops = [{ op: 'addMessage', threadId: t.id, id: uid('m_'), body: it.body.trim(), author: 'agent' }];
    if (it.resolve) ops.push({ op: 'setThreadStatus', threadId: t.id, status: 'resolved' });
    return ops;
  });
}

export async function cmdReply(repo) {
  const dir = dirForEdit(repo);
  let items;
  if (flags.json) {
    const src = typeof flags.json === 'string' ? flags.json : pos.shift() || '-';
    try {
      items = JSON.parse(fs.readFileSync(src === '-' ? 0 : src, 'utf8'));
    } catch (e) {
      die(`--json: ${e.message}`);
    }
    if (!Array.isArray(items) || !items.length) die('--json expects a non-empty array of {thread, body, resolve?}');
  } else if (flags.resolve && pos.length === 1 && !flags.file) {
    // `reply <thread> --resolve` without a body: resolve only
    const t = findThread(readState(dir), threadArg());
    await commitOps(dir, [{ op: 'setThreadStatus', threadId: t.id, status: 'resolved' }]);
    return console.log(`resolved ${t.id}`);
  } else items = [{ thread: threadArg(), body: readBody(), resolve: flags.resolve }];
  const ops = replyOps(readState(dir), items);
  await commitOps(dir, ops);
  if (flags.json) console.log(`replied to ${items.length} thread(s)`);
  else console.log(`replied to ${ops[0].threadId}${flags.resolve ? ' (resolved)' : ''}`);
}

export async function cmdComment(repo) {
  const dir = dirForEdit(repo);
  const ref = pos.shift() || die('missing rr: ref (or "general")');
  const id = uid('t_');
  await commitOps(dir, [{ op: 'createThread', id, anchor: parseAnchor(ref), msgId: uid('m_'), body: readBody(), author: 'agent' }]);
  console.log(id);
}
