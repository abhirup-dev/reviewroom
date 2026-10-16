#!/usr/bin/env node
// reviewroom CLI: local server + review rounds. `reviewroom --help` lists the commands; every command
// takes --help. Parsing and help come from cac (bundled into dist/cli/ by scripts/build.ts).
//
// The review dir defaults to <repo>/.reviewroom/<branch>/ (`pr <n>` uses pr-<n>/) and holds:
//   review.html            the narrative (written by the agent, any HTML)
//   state.json             threads, rounds, viewed files, sign-offs
//   config.json            repo/base/head/title
//   rounds/<n>/            snapshot of review.html + feedback.md for every finished round
import path from 'node:path';
import { cac } from 'cac';
import { die } from './lib/args.ts';
import { repoRoot } from './lib/git.ts';
import { cmdPr, type PrOpts } from './commands/pr.ts';
import { cmdServe, type ServeOpts } from './commands/serve.ts';
import { cmdThreads, cmdReply, cmdComment } from './commands/threads.ts';
import { cmdStatus, cmdStop, type StatusOpts } from './commands/status.ts';
import { cmdCheck } from './commands/check.ts';
import { ReviewroomError } from '../src/shared/ops.ts';

const cli = cac('reviewroom');
cli
  .option('--repo <path>', 'Git repo to review (default: the repo of the cwd)')
  .option('--dir <path>', 'Review dir (default: <repo>/.reviewroom/<branch>; `status --json` prints it)');

// cac's options, except that text stays text (cac turns "42" into 42) and a repeated flag keeps its last value
const run = <O>(fn: (repo: string | null, o: O, pos: string[]) => unknown) => async (...args: unknown[]) => {
  const o = args.pop() as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    const last: unknown = Array.isArray(v) ? v.at(-1) : v;
    if (typeof last === 'object' && k !== '--') die(`unknown option \`--${k}.…\`; see \`reviewroom --help\``, 2); // cac nests --a.b as an object
    o[k] = typeof last === 'number' ? String(last) : last;
  }
  const pos = args.filter((a) => a !== undefined) as string[];
  await fn(repoRoot(typeof o.repo === 'string' ? path.resolve(o.repo) : process.cwd()), o as O, pos);
};

cli
  .command('pr [target]', 'Create the review (fetching a PR if given one) and serve it')
  .usage('pr [<number> | <PR url> | <branch>] [options]\n\n  No target: review the current branch (or --base/--head) without fetching.\n  Review dir (unless --dir): .reviewroom/pr-<n> for a PR, .reviewroom/<branch> otherwise.')
  .option('--base <ref>', 'Base to diff against (default: the PR base, else the default branch)')
  .option('--head <ref>', 'Head when no target is given; `worktree` = uncommitted changes')
  .option('--title <text>', 'Review title')
  .option('--remote <name>', 'Remote to fetch from', { default: 'origin' })
  .option('--force', 'Overwrite an existing review.html with the scaffold')
  .option('--detach', 'Serve in the background, print the URL and return')
  .option('--wait', 'Then block like `review` until the round ends')
  .option('--port <n>', 'Port (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .example('  reviewroom pr 4821 --wait')
  .example('  reviewroom pr --head worktree --wait')
  .action(run<PrOpts>((repo, o, pos) => cmdPr(repo, o, pos[0])));

cli
  .command('review', 'Serve and block until the reviewer sends feedback or approves; print it')
  .option('--forever', 'Keep serving; never wait for a round (for a long-running session)')
  .option('--port <n>', 'Port (default: the previous one, else 4848)')
  .option('--no-open', 'Do not open the browser')
  .action(run<ServeOpts>((repo, o) => cmdServe(repo, o, !o.forever)));

cli
  .command('status', 'Round, threads, threads awaiting your reply')
  .option('--threads', 'List the open threads with their messages')
  .option('--all', 'With --threads: include resolved threads')
  .option('--json', 'Machine-readable: paths, URL, shas (and threads with --threads)')
  .action(run<StatusOpts & { threads?: boolean }>((repo, o) => (o.threads ? cmdThreads(repo, o) : cmdStatus(repo, o))));

cli
  .command('reply [thread] [body]', 'Answer a thread as the agent ("-" = body from stdin)')
  .option('--resolve', 'Resolve the thread; without a body, only resolve it')
  .option('--file <path>', 'Read the body from a file')
  .option('--json [file]', 'Bulk: [{"thread": id, "body": md, "resolve": bool}] from a file or "-"; all or nothing')
  .example('  reviewroom reply t_ab12 "Fixed in 3f2c1e"')
  .example('  reviewroom reply --json replies.json')
  .action(run(cmdReply));

cli
  .command('comment <ref> [body]', 'Start a thread as the agent on an rr: link, or "general"')
  .option('--file <path>', 'Read the body from a file')
  .action(run(cmdComment));

cli
  .command('check', 'Check rr: links in review.html against the code (exit 1 while any need attention)')
  .option('--fix', 'Rewrite links whose code moved a few lines')
  .option('--accept', 'Take every link as it is now')
  .option('--json', 'Print problems as JSON')
  .action(run(cmdCheck));

cli.command('stop', 'Stop a server started with --detach').action(run(cmdStop));

// What an agent needs beyond the flags, shown under the command's --help.
const ghThreads = '  gh_<n> threads are the PR\'s own GitHub threads (gh_conversation = its conversation tab): colleagues\'\n  threads, not feedback for you. You cannot reply to them; link one with rr:thread/gh_<n>.';
const notes: Record<string, string> = {
  reply: '  Thread ids can be shortened to a unique prefix. Resolving is the reviewer\'s call: pass --resolve only when\n  the user asks.\n' + ghThreads,
  status: ghThreads.replace('You cannot reply', '--threads lists the open ones under "Open on GitHub"; --json returns them as\n  `github`. You cannot reply'),
  check: [
    '  Each link in review.html is remembered by what it pointed at when first seen. Problems:',
    '    moved     same lines, now at most 5 lines away   → --fix rewrites the link',
    '    changed   code at those lines changed, or moved further, or a symbol lost its definition',
    '              → re-read the code; fix the link and the prose around it (or --accept if both still hold)',
    '    broken    the file, symbol or section (rr:doc/<id>) is gone → fix or remove the link',
    '  The server also checks on start and on every save of review.html. Links in HTML comments are ignored.',
  ].join('\n'),
};
// top level: one line instead of a --help line per command, the round loop and the review dir
cli.help((sections) => {
  // cac shows negated flags as "(default: true)", which reads as the opposite of what --no-open does
  sections = sections.map((x) => (x.body ? { ...x, body: x.body.replace(/(Do not open the browser) \(default: true\)/g, '$1') } : x));
  const c = cli.matchedCommand?.name;
  if (c) return notes[c] ? [...sections, { title: 'Notes', body: notes[c] }] : sections;
  return [
    ...sections.map((x) => (x.title?.startsWith('For more info') ? { ...x, body: '  $ reviewroom <command> --help' } : x)),
    {
      title: 'A review',
      body: [
        '  reviewroom pr <n> --wait         create + serve, block until the first round ends; write review.html meanwhile',
        '  reviewroom reply <thread> "…"    answer each thread in the feedback',
        '  reviewroom review --dir <dir>    serve and block until the next round ends; repeat until approved',
        '  Run the blocking commands in the background: a round can take hours. Threads, replies and rounds',
        '  are kept when the server stops between rounds.',
      ].join('\n'),
    },
    {
      title: 'The review dir',
      body: [
        '  <repo>/.reviewroom/<name>/, excluded from git. review.html and any assets next to it are yours;',
        '  everything else (state.json, config.json, rounds/) belongs to reviewroom: read and change it',
        '  through these commands only.',
      ].join('\n'),
    },
  ];
});

try {
  cli.parse(process.argv, { run: false });
  if (cli.matchedCommand) await cli.runMatchedCommand();
  else if (cli.args.length) die(`unknown command \`${cli.args[0]}\`; see \`reviewroom --help\``, 2);
  else if (!cli.options.help) cli.outputHelp();
} catch (e) {
  if ((e as Error).name === 'CACError') die(`${(e as Error).message}; see \`reviewroom ${cli.matchedCommandName ?? ''} --help\``.replace('  ', ' '), 2);
  if (!(e instanceof ReviewroomError)) throw e;
  die(e.message);
}
