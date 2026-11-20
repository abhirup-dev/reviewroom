#!/usr/bin/env bun
// reviewroom CLI: local server + review rounds. `reviewroom --help` lists the commands; every command
// takes --help. Parsing and help come from cac (bundled into dist/cli/ by scripts/build.ts).
//
// Reviews live under ~/.reviewroom/reviews/. What the agent
// writes there: docs/review-artifacts.md; reviewroom's own state: docs/review-state.md.
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import path from 'node:path';
import fs from 'node:fs';
import { cac } from 'cac';
import { die, type Global } from './lib/args.ts';
import { repoRoot } from './lib/git.ts';
import { resolveReview } from './lib/config.ts';
import { cmdPr, type PrOpts } from './commands/pr.ts';
import { cmdStart, cmdWait, type StartOpts } from './commands/serve.ts';
import { cmdThreads, cmdReply, cmdComment } from './commands/threads.ts';
import { cmdHome, cmdList, cmdStatus, cmdStop, type StatusOpts } from './commands/status.ts';
import { version } from '../package.json';
import { cmdCheck, WALKTHROUGH_SCHEMA } from './commands/check.ts';
import { cmdExport } from './commands/export.ts';
import { cmdPublishSlides } from './commands/walkthrough.ts';
import { cmdHub, type HubOpts } from './commands/hub.ts';
import { cmdShot } from './commands/shot.ts';
import { cmdSlideLint } from './commands/slides.ts';
import { ReviewroomError } from '../src/kernel/state/ops.shared.ts';
import { recordRead } from './lib/progress.ts';

if (process.argv.length === 3 && ['-v', '-V', '--version'].includes(process.argv[2] ?? '')) {
  console.log(version);
  process.exit(0);
}

const cli = cac('reviewroom');
cli
  .option('--repo <path>', 'Git repository; defaults to current repository');

// cac's options, except that text stays text (cac turns '42' into 42) and a repeated flag keeps its last value
const run = <O>(fn: (repo: string | null, o: O, pos: string[]) => unknown) => async (...args: unknown[]) => {
  const o = args.pop() as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    const last: unknown = Array.isArray(v) ? v.at(-1) : v;
    if (typeof last === 'object' && k !== '--') die(`unknown option \`--${k}....\`; see \`reviewroom --help\``, 2); // cac nests --a.b as an object
    o[k] = typeof last === 'number' ? String(last) : last;
  }
  const pos = args.filter((a) => a !== undefined) as string[];
  await fn(typeof o.repo === 'string' ? repoRoot(path.resolve(o.repo)) : repoRoot(process.cwd()), o as O, pos);
};

const forReview = <O extends Global>(command: string, fn: (repo: string | null, dir: string, o: O, pos: string[]) => unknown) =>
  (selected: string | null, o: O, [target, ...pos]: string[]) => {
    const { repo, dir } = resolveReview(selected, o, target, command);
    const needs = ['check', 'shot'].includes(command) ? REPORT_FILE : ['slide-lint', 'publish-slides', 'export'].includes(command) ? WALKTHROUGH_FILE : undefined;
    if (needs && !fs.existsSync(path.join(dir, needs))) throw new ReviewroomError(`no ${needs} in ${dir}`);
    return fn(repo, dir, o, pos);
  };

cli
  .command('pr <review>', 'Set up a review and start its server in the background')
  .usage('pr <review> [options]')
  .option('--base <ref>', 'Base: PR base or default branch')
  .option('--head <ref>', 'Head revision; worktree includes uncommitted changes')
  .option('--title <text>', 'Review title')
  .option('--remote <name>', 'Git remote (default: the saved PR remote or origin)')
  .option('--force', `Replace ${REPORT_FILE} and PR walkthrough`)
  .option('--profile <name>', 'Report profile: the report\'s sections and guide (default: explainer)')
  .option('--no-agent', 'Request no walkthrough or report; generation stays idle')
  .option('--no-serve', 'Set up the review only; start no server, print its dir')
  .option('--assistant', 'Run the built-in assistant for this review (its Ask panel, Generate)')
  .option('--port <n>', 'Port (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom pr \'acme/api#31\'')
  .example('  reviewroom pr feature --head worktree')
  .action(run<PrOpts>((repo, o, pos) => cmdPr(repo, o, pos[0])));

cli
  .command('start <review>', 'Ensure a review server is running')
  .usage('start <review> [options]')
  .option('--foreground', 'Run the server in this process')
  .option('--port <n>', 'Port for a new server (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom start \'acme/api#31\'')
  .action(run(forReview('start', cmdStart)));

cli
  .command('wait <review>', 'Wait for and print the next undelivered round')
  .usage('wait <review> [options]')
  .option('--port <n>', 'Port for a new server (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom wait \'acme/api#31\'')
  .action(run(forReview<StartOpts>('wait', cmdWait)));

cli
  .command('status <review>', 'Show review status and threads')
  .usage('status <review> [options]')
  .option('--threads', 'Include open threads and messages')
  .option('--all', 'Include resolved threads')
  .option('--json', 'Print JSON')
  .option('--full', 'With --threads --json: GitHub text uncut (default: 1000 characters)')
  .example('  reviewroom status \'acme/api#31\'')
  .example('  reviewroom status \'acme/api#31\' --threads')
  .action(run(forReview<StatusOpts & { threads?: boolean }>('status', (repo, dir, o) => (o.threads ? cmdThreads(repo, dir, o) : cmdStatus(repo, dir, o)))));

cli
  .command('reply <review> [thread] [body]', 'Reply to a thread')
  .usage('reply <review> [thread] [body] [options]')
  .option('--resolve', 'Resolve only when the user requests it')
  .option('--file <path>', 'Read input from a file')
  .option('--json [file]', 'Reply atomically from JSON file or stdin')
  .example('  reviewroom reply \'acme/api#31\' t_ab12 "Fixed in 3f2c1e"')
  .example('  reviewroom reply \'acme/api#31\' --json replies.json')
  .action(run(forReview('reply', cmdReply)));

cli
  .command('comment <review> <ref> [body]', 'Start a thread on a reference')
  .usage('comment <review> <ref> [body] [options]')
  .option('--file <path>', 'Read input from a file')
  .action(run(forReview('comment', cmdComment)));

cli
  .command('check <review>', 'Validate references and walkthrough schema')
  .usage('check <review> [options]')
  .option('--fix', 'Update links moved within five lines')
  .option('--accept', 'Refresh link fingerprints')
  .option('--json', 'Print JSON')
  .action(run(forReview('check', cmdCheck)));

cli
  .command('progress <review> <event>', 'Record generation progress for the loading screen')
  .usage('progress <review> read')
  .example('  reviewroom progress \'acme/api#31\' read')
  .action(run(forReview('progress', (_repo, dir, _o, [event]) => {
    if (event !== 'read') die(`unknown progress event \`${event}\`; see \`reviewroom progress --help\``, 2);
    console.log(recordRead(dir) ? 'recorded: you have read the diff' : 'nothing recorded: no walkthrough is requested (no-op)');
  })));

cli
  .command('slide-lint <review>', 'Audit all or selected walkthrough slides')
  .usage('slide-lint <review> [options]')
  .option('--jobs <n>', 'Concurrent pages: 1-8, default 1')
  .option('--chapter <id>', 'Chapter ID; excludes --slide')
  .option('--slide <chapter/step>', 'Slide IDs; excludes --chapter')
  .option('--viewport <WxH,...>', 'CSS viewports; default 1280x800,1440x900')
  .option('--native', 'Use native pixels instead of the 480-height cap')
  .option('--json', 'Print JSON')
  .example('  reviewroom slide-lint \'acme/api#31\'')
  .example('  reviewroom slide-lint \'acme/api#31\' --jobs 2')
  .example('  reviewroom slide-lint \'acme/api#31\' --chapter latency')
  .example('  reviewroom slide-lint \'acme/api#31\' --slide latency/s2')
  .action(run(forReview('slide-lint', cmdSlideLint)));

cli
  .command('publish-slides <review>', 'Publish walkthrough slides to the PR')
  .usage('publish-slides <review> [options]')
  .option('--dry-run', 'Print without posting')
  .option('--allow-stale', 'Allow stale links; schema must pass')
  .example('  reviewroom publish-slides \'acme/api#31\'')
  .action(run(forReview('publish-slides', cmdPublishSlides)));

cli
  .command('export <review>', 'Export a self-contained walkthrough with its source files (also available via Download in the desktop player)')
  .usage('export <review> [options]')
  .option('--out <path>', 'Override the output path (default: slugged <review-id>-<title>.html in the current directory)')
  .option('--allow-stale', 'Allow stale links; schema must pass')
  .example('  reviewroom export \'acme/api#31\' --out walkthrough.html')
  .action(run(forReview('export', cmdExport)));

cli
  .command('shot <review> [section]', 'Capture report sections or chapter/step slides')
  .usage('shot <review> [section] [options]')
  .option('--theme <light|dark>', 'Theme; default light')
  .option('--mobile', 'Review panel width: 390 CSS pixels')
  .option('--viewport <WxH>', 'Slide viewport; default 1280x800')
  .option('--native', 'Use native pixels instead of the 480-height cap')
  .option('--prose-only', 'Crop narration unchanged; skip right-hand code')
  .option('--out <dir>', 'PNG directory; defaults to temporary storage')
  .example('  reviewroom shot \'acme/api#31\'')
  .example('  reviewroom shot \'acme/api#31\' request-path --theme dark')
  .example('  reviewroom shot \'acme/api#31\' --mobile')
  .example('  reviewroom shot \'acme/api#31\' latency/s3 --theme dark')
  .example('  reviewroom shot \'acme/api#31\' latency/s3 --prose-only --native')
  .action(run(forReview('shot', cmdShot)));

cli
  .command('list', 'List running review servers')
  .option('--json', 'Print a JSON array of running reviews')
  .example('  reviewroom list --json')
  .action(run<{ json?: boolean }>((_repo, o) => cmdList(o)));

cli
  .command('stop <review>', 'Stop a review server')
  .usage('stop <review> [options]')
  .example('  reviewroom stop \'acme/api#31\'')
  .action(run(forReview('stop', cmdStop)));

cli
  .command('hub [action]', 'Serve or stop the local review hub')
  .usage('hub <serve|stop> [options]')
  .option('--detach', 'Serve in background; print URL')
  .option('--port <n>', 'Port (default: 4847)')
  .option('--public-origin <url>', 'Save public HTTPS origin; none clears it')
  .option('--no-open', 'Do not open the browser')
  .example('  reviewroom hub serve --detach')
  .example('  reviewroom hub stop')
  .action(run<HubOpts>((_repo, o, [action = 'serve']) => {
    if (action !== 'serve' && action !== 'stop') die(`unknown hub action \`${action}\`; see \`reviewroom hub --help\``, 2);
    return cmdHub({ ...o, stop: action === 'stop' });
  }));

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
  'progress': `  read: you have read the diff; the reviewer's loading screen moves on to writing the walkthrough.
  Applies to the walkthrough requested now; recording it twice is harmless.
  The walkthrough's saves and a passing full slide-lint are recorded without it.`,
  'publish-slides': `  Validates first; updates its existing PR comment.
  Uses GitHub authentication from gh.
  Rejects schema errors and comments exceeding 65,536 characters.`,
  'export': `  Validates first. Open the HTML directly in a browser.
  The file includes the source of the files shown in the walkthrough.
  Download in the live desktop player exports even if links are stale.`,
  'shot': `  Default: review panel width; phone width is 390 CSS pixels.
  Long sections split at 1400 CSS pixels.
  Slide targets use <chapter>/<step>; findings follow PNG paths.
  PNG height caps at 480 pixels; short images stay native.
  CSS layout stays unchanged; --native preserves native pixel density.
  Prose-only crops the existing pane without reflow.
  Skips right-hand code; embedded prose code still renders.
  Prose-only findings exclude right-hand code.
  Nothing is written to the review.`,
  'pr': `  Loads available PR walkthroughs into missing ${WALKTHROUGH_FILE} files.
  Newest author-owned or agent-owned walkthrough wins.
  Prints the review's url, directory, report, revisions and next steps.
  Reuses a running server and keeps its revision. After stopping it, rerun pr to fetch updates.
  A new or --force review asks the calling agent for both documents; the page waits for them.
  --no-agent sets the review up without asking anyone: the built-in assistant can generate later.
  --assistant turns the built-in assistant on for this review only (the hub's Play does the same); a plain pr never turns it off.
  --no-serve stops after setup: the hub's Add a PR runs pr <url> --no-agent --no-serve, and its Play starts the server.`,
  'start': `  Prints the review URL. Reuses a running server and its port.`,
  'list': `  Lists running reviews across repositories, as \`reviewroom\` does. The hub can be stopped.`,
  'wait': `  Starts a detached server if needed and leaves it running.
  Prints saved feedback or APPROVED to stdout and records delivery.`,
  'reply': `  Thread IDs accept unique prefixes.
  Bulk JSON: [{"thread":"id","body":"reply","resolve":false}].
  Resolve threads only when the user requests it.`,
  'hub': `  One hub per machine; repeated starts print its URL.
  Lists reviewroom, Crit, and Plannotator sessions without thread text.
  Reviews are proxied at /r/<id>/.
  Public URL: stderr; loopback URL: stdout.
  Public access requires an HTTPS front and --public-origin.
  The front controls access; Reviewroom checks no identity.
  Allowed visitors can read and modify every running review.`,
  'check': `  Tracks link fingerprints across ${REPORT_FILE} and ${WALKTHROUGH_FILE}.
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
  const c = cli.matchedCommand?.name;
  // cac shows each negated flag (--no-open, --no-serve, ...) as "(default: true)", which reads as the opposite of what it does
  const rows = sections.map((x) => x.title === 'Options'
    ? { ...x, body: x.body.split('\n').filter((line) => !/^--foreground\b/.test(line.trimStart())).join('\n').replace(/^(\s*--no-\S.*?) \(default: true\)$/gm, '$1') }
    : x);
  if (c) return notes[c] ? [...rows, { title: 'Notes', body: notes[c] }] : rows;
  return [
    ...rows.map((x) => (x.title?.startsWith('For more info') ? { ...x, body: '  $ reviewroom <command> --help' } : x)),
    {
      title: 'A review',
      body: [
        '  reviewroom (no command): running reviews and where to start.',
        '  pr \'acme/api#31\': set up a review and start its server.',
        '  wait \'acme/api#31\': await the next round in the background.',
        '  list: show running reviews and their URLs.',
        '  shot <review> [section]: inspect PNG output.',
        '  reply <review> <thread> "...": answer feedback.',
        '  stop \'acme/api#31\': stop the review server.',
        '  The server stays up between rounds.',
      ].join('\n'),
    },
    {
      title: 'A walkthrough (when wanted)',
      body: [
        `  ${WALKTHROUGH_FILE} sits beside ${REPORT_FILE}.`,
        '  progress <review> read: say you have read the diff.',
        '  slide-lint <review>: validate walkthrough slides.',
        '  export <review>: share a standalone walkthrough and the source it shows.',
        '  shot <review> <chapter>/<step>: inspect one slide.',
        '  publish-slides <review>: publish to the PR.',
      ].join('\n'),
    },
    {
      title: 'The review dir',
      body: [
        '  ~/.reviewroom/reviews/; REVIEWROOM_HOME overrides the root.',
        "  Every review command requires a target: 'owner/repo#n', PR URL, branch, or existing /absolute or ./relative review folder.",
        '  IDs and URLs work anywhere. Branches require their repository or --repo.',
        '  Only pr accepts a bare PR number, from its repository. Quote targets containing #.',
        `  Author ${REPORT_FILE}, ${WALKTHROUGH_FILE}, and adjacent assets.`,
        '  Change state, config, layouts, and rounds through CLI commands.',
      ].join('\n'),
    },
    {
      title: 'Experimental',
      body: [
        '  Per review: `pr --assistant`, or Play in the hub, sets "assistant": true in the review\'s config.json: an Assistant panel,',
        '  a Claude Code chat on this machine (native login, Bun only), which can also generate both documents.',
        '  Every assistant turn, generation (POST api/generate) or a question, approves every tool it asks for.',
        '  Requires Git and a Claude login. First use downloads the pinned agent runtime; no global plugin, Node or pnpm needed.',
        '  Agent runtime/cache: ~/.reviewroom/assistant/ (under REVIEWROOM_HOME); Claude login/settings stay native.',
        '  claudeExecutable: optional executable name or path (relative to config.json). Restart after changing it.',
        '  Selection: config override, CLAUDE_CODE_EXECUTABLE, claude on PATH, then the bundled binary.',
        '  ~/.reviewroom/config.json: defaultAgentHarness (claude), defaultReviewModel (sonnet), defaultReviewEffort (low..max).',
        '  reviewAgentPromptFile: custom Markdown prompt; relative paths resolve beside config.json.',
        '  Model changes apply to the next new question; restart for harness or prompt changes.',
        '  Conversation and transcript are saved in the review dir and restored when it reopens.',
        '  Only on the review\'s own URL: the hub (/r/<id>/) does not reach it.',
      ].join('\n'),
    },
  ];
});

try {
  cli.parse(process.argv, { run: false });
  const c = cli.matchedCommand;
  if (c) {
    if (!cli.options.help) c.checkUnknownOptions(); // a typo'd flag is reported before anything else
    if (!['hub', 'list'].includes(c.name) && !cli.args.length && !cli.options.help) {
      resolveReview(repoRoot(path.resolve(cli.options.repo ?? process.cwd())), cli.options, undefined, c.name);
    }
    await cli.runMatchedCommand();
  }
  else if (cli.args.length) die(`unknown command \`${cli.args[0]}\`\nhelp: commands: ${cli.commands.map((x) => x.name).join(', ')}`, 2);
  else if (!cli.options.help) await cmdHome();
} catch (e) {
  const c = cli.matchedCommand;
  if ((e as Error).name === 'CACError' && (e as Error).message.includes('Unknown option `--dir`')) die('--dir was removed; use reviewroom <command> <review-folder> instead', 2);
  if ((e as Error).name === 'CACError') {
    const flags = c ? [...c.options, ...cli.globalCommand.options].map((x) => x.rawName).join(', ') : '';
    die(`${(e as Error).message.replace(/^Unknown option/, 'unknown flag')}${c ? `\nhelp: reviewroom ${c.rawName}; flags: ${flags}` : ''}`, 2);
  }
  if (!(e instanceof ReviewroomError)) throw e;
  die(e.message, e.status === 2 ? 2 : 1);
}
