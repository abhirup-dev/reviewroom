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
  .option('--repo <path>', 'Git repository; defaults to current repository')
  .option('--dir <path>', 'Review directory; see status --json');

// cac's options, except that text stays text (cac turns '42' into 42) and a repeated flag keeps its last value
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
  .command('pr [target]', 'Create and serve a review')
  .usage('pr [number|URL|branch] [options]')
  .option('--base <ref>', 'Base: PR base or default branch')
  .option('--head <ref>', 'Head revision; worktree includes uncommitted changes')
  .option('--title <text>', 'Review title')
  .option('--remote <name>', 'Git remote', { default: 'origin' })
  .option('--force', 'Replace review.html and PR walkthrough')
  .option('--detach', 'Serve in background; print URL')
  .option('--wait', 'Wait for the first feedback round')
  .option('--port <n>', 'Port (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom pr 4821 --wait')
  .example('  reviewroom pr --head worktree --wait')
  .action(run<PrOpts>((repo, o, pos) => cmdPr(repo, o, pos[0])));

cli
  .command('review', 'Serve until feedback arrives')
  .option('--forever', 'Serve continuously without waiting for feedback')
  .option('--port <n>', 'Port (default: the previous one, else 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .action(run<ServeOpts>((repo, o) => cmdServe(repo, o, !o.forever)));

cli
  .command('status', 'Show review status and threads')
  .option('--threads', 'Include open threads and messages')
  .option('--all', 'Include resolved threads')
  .option('--json', 'Print JSON')
  .action(run<StatusOpts & { threads?: boolean }>((repo, o) => (o.threads ? cmdThreads(repo, o) : cmdStatus(repo, o))));

cli
  .command('reply [thread] [body]', 'Reply to a thread')
  .option('--resolve', 'Resolve only when the user requests it')
  .option('--file <path>', 'Read input from a file')
  .option('--json [file]', 'Reply atomically from JSON file or stdin')
  .example('  reviewroom reply t_ab12 "Fixed in 3f2c1e"')
  .example('  reviewroom reply --json replies.json')
  .action(run(cmdReply));

cli
  .command('comment <ref> [body]', 'Start a thread on a reference')
  .option('--file <path>', 'Read input from a file')
  .action(run(cmdComment));

cli
  .command('check', 'Validate references and walkthrough schema')
  .option('--fix', 'Update links moved within five lines')
  .option('--accept', 'Refresh link fingerprints')
  .option('--json', 'Print JSON')
  .action(run(cmdCheck));

cli
  .command('slide-lint', 'Audit all or selected guided slides')
  .option('--jobs <n>', 'Concurrent pages: 1-8, default 1')
  .option('--chapter <id>', 'Chapter ID; excludes --slide')
  .option('--slide <chapter/step>', 'Slide IDs; excludes --chapter')
  .option('--viewport <WxH,...>', 'CSS viewports; default 1280x800,1440x900')
  .option('--native', 'Use native pixels instead of the 480-height cap')
  .option('--json', 'Print JSON')
  .example('  reviewroom slide-lint')
  .example('  reviewroom slide-lint --jobs 2')
  .example('  reviewroom slide-lint --chapter latency')
  .example('  reviewroom slide-lint --slide latency/s2')
  .action(run(cmdSlideLint));

cli
  .command('publish-slides', 'Publish guided slides to the PR')
  .option('--dry-run', 'Print without posting')
  .option('--allow-stale', 'Allow stale links; schema must pass')
  .example('  reviewroom publish-slides')
  .action(run(cmdPublishSlides));

cli
  .command('shot [section]', 'Capture review sections or chapter/step slides')
  .option('--theme <light|dark>', 'Theme; default light')
  .option('--mobile', 'Review panel width: 390 CSS pixels')
  .option('--viewport <WxH>', 'Slide viewport; default 1280x800')
  .option('--native', 'Use native pixels instead of the 480-height cap')
  .option('--prose-only', 'Crop narration unchanged; skip right-hand code')
  .option('--out <dir>', 'PNG directory; defaults to temporary storage')
  .example('  reviewroom shot')
  .example('  reviewroom shot request-path --theme dark')
  .example('  reviewroom shot --mobile')
  .example('  reviewroom shot latency/s3 --theme dark')
  .example('  reviewroom shot latency/s3 --prose-only --native')
  .action(run(cmdShot));

cli.command('stop', 'Stop a detached review server').action(run(cmdStop));

cli
  .command('hub', 'List local review sessions')
  .option('--detach', 'Serve in background; print URL')
  .option('--stop', 'Stop the running hub')
  .option('--port <n>', 'Port (default: 4847)')
  .option('--public-origin <url>', 'Save public HTTPS origin; none clears it')
  .option('--no-open', 'Do not open the browser')
  .action(run<HubOpts>((_repo, o) => cmdHub(o)));

// What an agent needs beyond the flags, shown under the command's --help.
const notes: Record<string, string> = {
  'slide-lint': `  Read-only: schema, links, focus, overflow, code visibility, sanitization.
  Warnings exit 1; findings identify slides and fixes.
  Selectors use IDs; --slide also accepts rr:tour/<chapter>/<step>.
  Partial checks retain leads and inherited targets.
  Partial checks skip whole-tour coverage and pacing.
  Run without selectors for final validation.
  Workers share a server; pages stay isolated.
  JSON: engine, jobs, viewports, rasterHeight, selection, coverage, links, findings.
  Chrome caps raster scale; WebKit scales screenshot output.
  CSS geometry stays unchanged.`,
  'publish-slides': `  Validates first; updates its existing PR comment.
  Uses GitHub authentication from gh.
  Rejects schema errors and comments exceeding 65,536 characters.`,
  'shot': `  Default: review panel width; phone width is 390 CSS pixels.
  Long sections split at 1400 CSS pixels.
  Slide targets use <chapter>/<step>; findings follow PNG paths.
  PNG height caps at 480 pixels; short images stay native.
  CSS layout stays unchanged; --native preserves native pixel density.
  Prose-only crops the existing pane without reflow.
  Skips right-hand code; embedded prose code still renders.
  Prose-only findings exclude right-hand code.
  Nothing is written to the review.`,
  'pr': `  Loads available PR walkthroughs into missing walkthrough.json files.
  Newest author-owned or agent-owned walkthrough wins.`,
  'reply': `  Thread IDs accept unique prefixes.
  Bulk JSON: [{"thread":"id","body":"reply","resolve":false}].
  Resolve threads only when the user requests it.
  gh_<n> identifies GitHub threads; gh_conversation identifies PR conversation.
  These belong to colleagues; agents cannot reply.
  Link them with rr:thread/gh_<n>.`,
  'status': `  gh_<n> identifies GitHub threads; gh_conversation identifies PR conversation.
  These belong to colleagues; agents cannot reply.
  Link them with rr:thread/gh_<n>.`,
  'hub': `  One hub per machine; repeated starts print its URL.
  Lists reviewroom, Crit, and Plannotator sessions without thread text.
  Reviews are proxied at /r/<id>/.
  Public URL: stderr; loopback URL: stdout.
  Public access requires an HTTPS front and --public-origin.
  The front controls access; Reviewroom checks no identity.
  Allowed visitors can read and modify every running review.`,
  'check': `  Tracks link fingerprints across review.html and walkthrough.json.
  Moved: within five lines; --fix updates links.
  Changed: inspect code and prose; --accept refreshes fingerprints.
  Broken: fix or remove missing targets.
  Broken schema or unresolved links exit 1.
  Walkthrough schema: ${WALKTHROUGH_SCHEMA}
  Notes cover coverage, chapter sizing, text, and highlighted-code budgets.
  Budgets: 120 words; 25 lines, or 10 per stack.
  Chapter budgets: 2-6 slides; at most two stacked refs.
  Notes do not change check's exit status.
  HTML comments are ignored; servers recheck after saves.`,
};
// top level: one line instead of a --help line per command, the round loop and the review dir
cli.help((sections) => {
  // cac shows negated flags as '(default: true)', which reads as the opposite of what --no-open does
  const rows = sections.map((x) => (x.body ? { ...x, body: x.body.replace(/(Do not open the browser) \(default: true\)/g, '$1') } : x));
  const c = cli.matchedCommand?.name;
  if (c) return notes[c] ? [...rows, { title: 'Notes', body: notes[c] }] : rows;
  return [
    ...rows.map((x) => (x.title?.startsWith('For more info') ? { ...x, body: '  $ reviewroom <command> --help' } : x)),
    {
      title: 'A review',
      body: [
        '  pr <n> --wait: create, serve, await feedback.',
        '  shot [section]: inspect PNG output.',
        '  reply <thread> "...": answer feedback.',
        '  review --dir <dir>: await the next round.',
        '  Run waiting commands in background; rounds may take hours.',
        '  Threads and rounds survive server restarts.',
      ].join('\n'),
    },
    {
      title: 'A guided walkthrough (when wanted)',
      body: [
        '  walkthrough.json sits beside review.html.',
        '  slide-lint: validate guided slides.',
        '  shot <chapter>/<step>: inspect one slide.',
        '  publish-slides: publish to the PR.',
      ].join('\n'),
    },
    {
      title: 'The review dir',
      body: [
        '  ~/.reviewroom/reviews/<owner>-<repo>/<branch>/; REVIEWROOM_HOME overrides the root.',
        '  Author review.html, walkthrough.json, and adjacent assets.',
        '  Change state, config, layouts, and rounds through CLI commands.',
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
