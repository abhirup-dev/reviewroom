// threads / reply / comment / resolve: the agent's side of the conversation, straight on state.json
import fs from 'node:fs';
import { flags, pos, die } from '../lib/args.mjs';
import { dirForEdit, readState, writeState, uid, parseAnchor } from '../lib/state.mjs';
import { anchorText, anchorRef } from '../lib/feedback.mjs';

function threadArg() {
  const id = pos.shift();
  if (!id) die('missing thread id');
  return id;
}
function findThread(s, id) {
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
  if (flags.json) {
    console.log(JSON.stringify({ round: s.round, threads: list }, null, 2));
    return;
  }
  console.log(`round ${s.round} · ${list.length} ${flags.all ? '' : 'open '}thread(s)`);
  for (const t of list) {
    const last = t.messages[t.messages.length - 1];
    console.log(`\n${t.id}  [${t.status}]  ${anchorText(t.anchor)}${anchorRef(t.anchor) ? `  (${anchorRef(t.anchor)})` : ''}`);
    for (const m of t.messages) console.log(`  ${m.author}@r${m.round}: ${m.body.split('\n').join('\n    ')}`);
    if (last?.author === 'you') console.log('  → awaiting agent reply');
  }
}

export function cmdReply(repo) {
  const dir = dirForEdit(repo);
  const id = threadArg();
  const bodyText = readBody();
  const s = readState(dir);
  const t = findThread(s, id);
  t.messages.push({ id: uid('m_'), author: 'agent', round: s.round, body: bodyText, at: new Date().toISOString() });
  if (flags.resolve) t.status = 'resolved';
  writeState(dir, s);
  console.log(`replied to ${t.id}${flags.resolve ? ' (resolved)' : ''}`);
}

export function cmdComment(repo) {
  const dir = dirForEdit(repo);
  const ref = pos.shift() || die('missing rr: ref (or "general")');
  const bodyText = readBody();
  const s = readState(dir);
  const t = { id: uid('t_'), anchor: parseAnchor(ref), status: 'open', createdRound: s.round, messages: [{ id: uid('m_'), author: 'agent', round: s.round, body: bodyText, at: new Date().toISOString() }] };
  s.threads.push(t);
  writeState(dir, s);
  console.log(t.id);
}

export function cmdResolve(repo) {
  const dir = dirForEdit(repo);
  const s = readState(dir);
  findThread(s, threadArg()).status = 'resolved';
  writeState(dir, s);
  console.log('resolved');
}
