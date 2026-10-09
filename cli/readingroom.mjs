#!/usr/bin/env node
// readingroom CLI — local server + review rounds.  Zero dependencies.
//
//   readingroom pr <number|url|branch> [--repo path] [--detach] [--wait]
//                      one step: fetch the PR (gh if available), scaffold .readingroom/pr-<n>/,
//                      start the server. --detach backgrounds it; --wait blocks for the round.
//   readingroom stop   [dir]            stop a detached server
//   readingroom init   [dir] [--base main] [--head HEAD] [--title "…"]   scaffold a review
//   readingroom review [dir] [...]   serve, open the browser, block until the reviewer sends
//                                    feedback or approves; print the feedback for the agent
//   readingroom serve  [dir] [...]   same server, never exits (for a long-running session)
//   readingroom threads [dir] [--all] [--json]       list threads (what the agent must answer)
//   readingroom reply <thread> "<markdown>" [--resolve] [dir]   answer a thread as the agent ("-" = stdin)
//   readingroom comment <rr-ref> "<markdown>" [dir]  start a thread as the agent
//   readingroom resolve <thread> [dir]
//   readingroom status [dir]
//
// The review dir defaults to <repo>/.readingroom/<branch>/ and holds:
//   review.html            the narrative (written by the agent, any HTML)
//   state.json             threads, rounds, viewed files, sign-offs
//   config.json            repo/base/head/title
//   rounds/<n>/            snapshot of review.html + feedback.md for every finished round
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmd, flags } from './lib/args.mjs';
import { repoRoot } from './lib/git.mjs';
import { cmdPr } from './commands/pr.mjs';
import { cmdServe } from './commands/serve.mjs';
import { cmdInit } from './commands/init.mjs';
import { cmdThreads, cmdReply, cmdComment, cmdResolve } from './commands/threads.mjs';
import { cmdStatus, cmdStop } from './commands/status.mjs';

const repo = repoRoot(flags.repo ? path.resolve(flags.repo) : process.cwd());

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
    cmdReply(repo);
    break;
  case 'comment':
    cmdComment(repo);
    break;
  case 'resolve':
    cmdResolve(repo);
    break;
  case 'status':
    cmdStatus(repo);
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
