#!/usr/bin/env node
// reviewroom CLI — local server + review rounds.  Zero dependencies.
//
//   reviewroom pr <number|url|branch> [--repo path] [--detach] [--wait]
//                      one step: fetch the PR (gh if available), scaffold .reviewroom/pr-<n>/,
//                      start the server. --detach backgrounds it; --wait blocks for the round.
//   reviewroom stop   [dir]            stop a detached server
//   reviewroom init   [dir] [--base main] [--head HEAD] [--title "…"]   scaffold a review
//   reviewroom review [dir] [...]   serve, open the browser, block until the reviewer sends
//                                    feedback or approves; print the feedback for the agent
//   reviewroom serve  [dir] [...]   same server, never exits (for a long-running session)
//   reviewroom threads [dir] [--all] [--json]       list threads (what the agent must answer)
//   reviewroom reply <thread> "<markdown>" [--resolve] [dir]   answer a thread as the agent ("-" = stdin)
//   reviewroom reply --json <file|->   bulk answers: [{"thread": id, "body": md, "resolve": bool}]
//   reviewroom comment <rr-ref> "<markdown>" [dir]  start a thread as the agent
//   reviewroom resolve <thread> [dir]
//   reviewroom status [dir]
//   reviewroom check [dir] [--fix] [--accept] [--json]   stale rr: links in review.html (exit 1 if any)
//
// The review dir defaults to <repo>/.reviewroom/<branch>/ and holds:
//   review.html            the narrative (written by the agent, any HTML)
//   state.json             threads, rounds, viewed files, sign-offs
//   config.json            repo/base/head/title
//   rounds/<n>/            snapshot of review.html + feedback.md for every finished round
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmd, flags, die } from './lib/args.mjs';
import { repoRoot } from './lib/git.mjs';
import { cmdPr } from './commands/pr.mjs';
import { cmdServe } from './commands/serve.mjs';
import { cmdInit } from './commands/init.mjs';
import { cmdThreads, cmdReply, cmdComment, cmdResolve } from './commands/threads.mjs';
import { cmdStatus, cmdStop } from './commands/status.mjs';
import { cmdCheck } from './commands/check.mjs';
import { OpError } from './lib/ops.mjs';
import { StateError } from './lib/state.mjs';

const repo = repoRoot(flags.repo ? path.resolve(flags.repo) : process.cwd());

try {
switch (cmd) {
  case 'pr':
    await cmdPr(repo);
    break;
  case 'stop':
    await cmdStop(repo);
    break;
  case 'serve':
    await cmdServe(repo, false);
    break;
  case 'review':
    await cmdServe(repo, true);
    break;
  case 'init':
    cmdInit(repo);
    break;
  case 'threads':
    cmdThreads(repo);
    break;
  case 'reply':
    await cmdReply(repo);
    break;
  case 'comment':
    await cmdComment(repo);
    break;
  case 'resolve':
    await cmdResolve(repo);
    break;
  case 'status':
    cmdStatus(repo);
    break;
  case 'check':
    await cmdCheck(repo);
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
} catch (e) {
  if (!(e instanceof OpError || e instanceof StateError)) throw e;
  die(e.message);
}
