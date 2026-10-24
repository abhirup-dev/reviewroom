#!/usr/bin/env bun
// reviewroom CLI: local server + review rounds. `reviewroom --help` lists the commands; every command
// takes --help. Parsing and help come from cac (bundled into dist/cli/ by scripts/build.ts).
//
// The review dir defaults to ~/.reviewroom/reviews/<owner>-<repo>/<branch>/ (a PR's head branch) and holds:
//   review.html            the walkthrough (written by the agent, any HTML)
//   walkthrough.json       the guided walkthrough, optional (written by the agent)
//   state.json             threads, rounds, viewed files, sign-offs
//   config.json            repoPath/base/head/title
//   layout.json            the panel layout as the reviewer left it (written by the browser)
//   rounds/<n>/            snapshot of review.html + feedback.md for every finished round
import path from 'node:path';
import { cac } from 'cac';
import { die } from './lib/args.ts';
import { repoRoot } from './lib/git.ts';
import { readConfig } from './lib/config.ts';
import { cmdPr, type PrOpts } from './commands/pr.ts';
import { cmdServe, type ServeOpts } from './commands/serve.ts';
import { cmdThreads, cmdReply, cmdComment } from './commands/threads.ts';
import { cmdStatus, cmdStop, type StatusOpts } from './commands/status.ts';
import { cmdCheck, WALKTHROUGH_SCHEMA } from './commands/check.ts';
import { cmdPublishSlides } from './commands/walkthrough.ts';
import { cmdHub, type HubOpts } from './commands/hub.ts';
import { cmdShot } from './commands/shot.ts';
import { cmdSlideLint } from './commands/slides.ts';
import { ReviewroomError } from '../src/kernel/state/ops.shared.ts';

const cli = cac('reviewroom');
cli
  .option('--repo <path>', 'Git repo to review (default: the repo of the cwd)')
  .option('--dir <path>', 'Review dir (default: ~/.reviewroom/reviews/<owner>-<repo>/<branch>; `status --json` prints it)');

// cac's options, except that text stays text (cac turns "42" into 42) and a repeated flag keeps its last value
const run = <O>(fn: (repo: string | null, o: O, pos: string[]) => unknown) => async (...args: unknown[]) => {
  const o = args.pop() as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    const last: unknown = Array.isArray(v) ? v.at(-1) : v;
    if (typeof last === 'object' && k !== '--') die(`unknown option \`--${k}....\`; see \`reviewroom --help\``, 2); // cac nests --a.b as an object
    o[k] = typeof last === 'number' ? String(last) : last;
  }
  const pos = args.filter((a) => a !== undefined) as string[];
  // the repo: --repo, else the one a --dir review was made from (none if it is gone: never the cwd's instead), else the cwd's
  const made = typeof o.dir === 'string' ? readConfig(path.resolve(o.dir)).repoPath : undefined;
  await fn(typeof o.repo === 'string' ? repoRoot(path.resolve(o.repo)) : repoRoot(made || process.cwd()), o as O, pos);
};

cli
  .command('pr [target]', 'Create the review (fetching a PR if given one) and serve it')
  .usage('pr [<number> | <PR url> | <branch>] [options]\n\n  No target: review the current branch (or --base/--head) without fetching.\n  Review dir (unless --dir): ~/.reviewroom/reviews/<owner>-<repo>/<branch> (for a PR, its head branch).')
  .option('--base <ref>', 'Base to diff against (default: the PR base, else the default branch)')
  .option('--head <ref>', 'Head when no target is given; `worktree` = uncommitted changes')
  .option('--title <text>', 'Review title')
  .option('--remote <name>', 'Remote to fetch from', { default: 'origin' })
  .option('--force', 'Overwrite an existing review.html with the scaffold (and walkthrough.json with the PR\'s guided walkthrough)')
  .option('--detach', 'Serve in the background, print the URL and return')
  .option('--wait', 'Then block like `review` until the round ends')
  .option('--port <n>', 'Port (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open in the browser even when the macOS app is installed')
  .example('  reviewroom pr 4821 --wait')
  .example('  reviewroom pr --head worktree --wait')
  .action(run<PrOpts>((repo, o, pos) => cmdPr(repo, o, pos[0])));

cli
  .command('review', 'Serve and block until the reviewer sends feedback or approves; print it')
  .option('--forever', 'Keep serving; never wait for a round (for a long-running session)')
  .option('--port <n>', 'Port (default: the previous one, else 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open in the browser even when the macOS app is installed')
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
  .command('check', 'Check rr: links in review.html and walkthrough.json against the code (exit 1 while any need attention, or walkthrough.json breaks its schema)')
  .option('--fix', 'Rewrite links whose code moved a few lines')
  .option('--accept', 'Take every link as it is now')
  .option('--json', 'Print problems as JSON: { links, walkthrough }, plus schema (the issues) when walkthrough.json breaks its schema')
  .action(run(cmdCheck));

cli
  .command('slide-lint', 'Check the guided walkthrough (walkthrough.json), then measure every slide on screen in a headless browser')
  .option('--viewport <WxH,...>', 'Viewports to measure at (default 1280x800,1440x900)')
  .option('--json', 'Print { engine, viewports, links, findings } as JSON')
  .example('  reviewroom slide-lint')
  .action(run(cmdSlideLint));

cli
  .command('publish-slides', 'Post the guided walkthrough (walkthrough.json) to the PR, where `reviewroom pr <n>` picks it up')
  .option('--dry-run', 'Print the comment instead of posting it')
  .option('--allow-stale', 'Post even if some links need attention (never with schema errors)')
  .example('  reviewroom publish-slides')
  .action(run(cmdPublishSlides));

cli
  .command('shot [section]', 'The review as the reviewer reads it, as PNGs (one picture if short, else one per section; a tall section in parts), to look at without a browser. <chapter>/<step>: one guided-walkthrough slide instead, with what slide-lint finds on it')
  .option('--theme <light|dark>', 'The theme (default light)')
  .option('--mobile', 'As on a phone: the panel 390 CSS px wide')
  .option('--viewport <WxH>', 'A slide: the screen (default 1280x800)')
  .option('--out <dir>', 'Where to write the PNGs (default: a temp dir, emptied first for the review; the paths are printed)')
  .example('  reviewroom shot')
  .example('  reviewroom shot request-path --theme dark')
  .example('  reviewroom shot --mobile')
  .example('  reviewroom shot latency/s3 --theme dark')
  .action(run(cmdShot));

cli.command('stop', 'Stop a server started with --detach').action(run(cmdStop));

cli
  .command('hub', 'Every review running on this machine (reviewroom, Crit, Plannotator) on one page')
  .option('--detach', 'Run in the background, print the URL and return')
  .option('--stop', 'Stop the running hub')
  .option('--port <n>', 'Port (default: 4847)')
  .option('--no-open', 'Do not open the browser')
  .action(run<HubOpts>((_repo, o) => cmdHub(o)));

// What an agent needs beyond the flags, shown under the command's --help.
const ghThreads = '  gh_<n> threads are the PR\'s own GitHub threads (gh_conversation = its conversation tab): colleagues\'\n  threads, not feedback for you. You cannot reply to them; link one with rr:thread/gh_<n>.';
const notes: Record<string, string> = {
  'slide-lint': [
    '  Runs `check` (schema, links, what the guided walkthrough leaves out, its pacing), then plays every slide in a headless',
    '  browser (a fresh Chrome; on macOS without Chrome, Safari\'s engine) on the review as built now, and reports',
    '  what the reviewer would hit: narration that needs scrolling, highlighted lines off screen, stacked chunks too',
    '  short to read, content wider than its box, prose the sanitizer strips, page errors. Each finding names the',
    '  slide (chapter/step) and how to fix it; exit 1 while any warning is left. Nothing is written.',
  ].join('\n'),
  'publish-slides': [
    '  Runs `check` on walkthrough.json first, then posts it as a PR conversation comment holding a',
    '  ```reviewroom-walkthrough block (as gh\'s user); publishing again updates that comment. `reviewroom pr <n>`',
    '  on another machine pulls it. A comment over GitHub\'s 65,536 characters is refused.',
  ].join('\n'),
  shot: [
    '  Renders review.html in a headless browser (a fresh Chrome; on macOS without Chrome, Safari\'s engine) as the',
    '  Review panel shows it, alone, as wide as in the default layout on a 1280x800 screen. A review up to 1400 px',
    '  tall is one picture; a longer one gets a picture per section (the Contents\' sections: top-level <section id>),',
    '  the title and lead going with the first. A section over 1400 px is cut between its blocks into parts',
    '  (<n>-<id>-1.png, -2, ...). [section] renders that section only. --mobile renders it 390 px wide, as on a',
    '  phone (the review is also read there). Prints each PNG\'s path and size, then what sticks out past the',
    '  panel\'s edge (by section and element; a box that scrolls or clips its content counts as fitting), then the',
    '  page\'s script errors. Optional: for checking your own HTML, or a layout problem the reviewer reports.',
    '  Nothing in the review is written.',
    '  shot <chapter>/<step> renders one guided-walkthrough slide instead (after it settles) and prints the PNG\'s',
    '  path, then that slide\'s slide-lint findings.',
  ].join('\n'),
  pr: '  A PR that carries a guided walkthrough (a ```reviewroom-walkthrough block in its description, or in a comment by its\n  author or you; see `publish-slides`) gets it as walkthrough.json when the review has none. Newest wins.',
  reply: '  Thread ids can be shortened to a unique prefix. Resolving is the reviewer\'s call: pass --resolve only when\n  the user asks.\n' + ghThreads,
  status: ghThreads.replace('You cannot reply', '--threads lists the open ones under "Open on GitHub"; --json returns them as\n  `github`. You cannot reply'),
  hub: [
    '  One hub per machine; a second `hub` prints the running one\'s URL. A review\'s "All reviews" button starts',
    '  it in the background when none runs. It lists servers from ~/.reviewroom/sessions, ~/.crit/sessions and',
    '  Plannotator\'s sessions dir, shows counts (never thread text) and can close a session.',
  ].join('\n'),
  check: [
    '  Each link in review.html is remembered by what it pointed at when first seen. Problems:',
    '    moved     same lines, now at most 5 lines away   -> --fix rewrites the link',
    '    changed   code at those lines changed, or moved further, or a symbol lost its definition',
    '              -> re-read the code; fix the link and the prose around it (or --accept if both still hold)',
    '    broken    the file, symbol or section (rr:doc/<id>) is gone -> fix or remove the link',
    `  walkthrough.json, when present, must match ${WALKTHROUGH_SCHEMA} (checked first); its slide refs and`,
    '  the links in its prose are checked like the walkthrough\'s, and problems name the slide (chapter/step) they are in.',
    '  Then whether it works as a guided walkthrough (notes, exit code unaffected): changed files no slide shows,',
    '  chapters of one slide or more than 6, and estimates of slides too long to fit (over 120 words;',
    '  over about 25 highlighted lines for one ref, 10 each for two stacked; more than two refs stacked). Each note says how to fix it.',
    '  The server also checks on start and on every save of review.html or walkthrough.json. Links in HTML comments are ignored.',
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
        '  reviewroom shot [section]        look at the review as PNGs, when you want to (no browser needed)',
        '  reviewroom reply <thread> "..."    answer each thread in the feedback',
        '  reviewroom review --dir <dir>    serve and block until the next round ends; repeat until approved',
        '  Run the blocking commands in the background: a round can take hours. Threads, replies and rounds',
        '  are kept when the server stops between rounds.',
      ].join('\n'),
    },
    {
      title: 'A guided walkthrough (when wanted)',
      body: [
        '  walkthrough.json next to review.html: the main story of the diff as slides, played over the workbench',
        '  reviewroom slide-lint             check it, then measure every slide on screen; repeat until clean',
        '  reviewroom shot <chapter>/<step>  one slide as a PNG, to look at what a finding names',
        '  reviewroom publish-slides         post it to the PR, where `reviewroom pr <n>` picks it up',
      ].join('\n'),
    },
    {
      title: 'The review dir',
      body: [
        '  ~/.reviewroom/reviews/<owner>-<repo>/<branch>/ (REVIEWROOM_HOME moves ~/.reviewroom), outside',
        '  the repo. review.html, walkthrough.json and any assets next to them are yours; everything else',
        '  (state.json, config.json, layout.json, rounds/) belongs to reviewroom: read and change it through',
        '  these commands only.',
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
