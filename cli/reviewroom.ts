#!/usr/bin/env bun
// reviewroom CLI: local server + review rounds. `reviewroom --help` lists the commands; every command
// takes --help. Parsing and help come from cac (bundled into dist/cli/ by scripts/build.ts).
//
// Reviews live under ~/.reviewroom/reviews/. What the agent
// writes there: docs/review-artifacts.md; reviewroom's own state: docs/review-state.md.
import { REPORT_FILE, WALKTHROUGH_FILE } from '../src/kernel/state/files.shared.ts';
import path from 'node:path';
import { cac } from 'cac';
import { die, type Global } from './lib/args.ts';
import { repoRoot } from './lib/git.ts';
import { readConfig, resolveReview } from './lib/config.ts';
import { cmdPr, type PrOpts } from './commands/pr.ts';
import { cmdStart, cmdWait, type StartOpts } from './commands/serve.ts';
import { cmdThreads, cmdReply, cmdComment } from './commands/threads.ts';
import { cmdList, cmdStatus, cmdStop, type StatusOpts } from './commands/status.ts';
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

const forReview = <O extends Global>(command: string, fn: (repo: string | null, dir: string, o: O) => unknown) =>
  (selected: string | null, o: O, [target]: string[]) => {
    const { repo, dir } = resolveReview(selected, o, target, command);
    return fn(repo, dir, o);
  };

cli
  .command('pr [target]', 'Set up a review and start its server in the background')
  .usage('pr [id|number|URL|branch] [options]')
  .option('--base <ref>', 'Base: PR base or default branch')
  .option('--head <ref>', 'Head revision; worktree includes uncommitted changes')
  .option('--title <text>', 'Review title')
  .option('--remote <name>', 'Git remote (default: the saved PR remote or origin)')
  .option('--force', `Replace ${REPORT_FILE} and PR walkthrough`)
  .option('--profile <name>', 'Report profile: the report\'s sections and guide (default: explainer)')
  .option('--detach', 'Compatibility flag; the server always runs in the background')
  .option('--wait', 'Then wait for the next undelivered round')
  .option('--port <n>', 'Port (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom pr acme/api#31')
  .example('  reviewroom pr --head worktree')
  .action(run<PrOpts>((repo, o, pos) => cmdPr(repo, o, pos[0])));

cli
  .command('start [target]', 'Ensure a review server is running')
  .usage('start [id|number|URL|branch] [options]')
  .option('--foreground', 'Run the server in this process')
  .option('--port <n>', 'Port for a new server (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom start acme/api#31')
  .action(run(forReview('start', cmdStart)));

cli
  .command('wait [target]', 'Wait for and print the next undelivered round')
  .usage('wait [id|number|URL|branch] [options]')
  .alias('review')
  .option('--forever', 'Compatibility flag; ignored')
  .option('--port <n>', 'Port for a new server (default: 4848)')
  .option('--no-open', 'Do not open the browser')
  .option('--browser', 'Open browser instead of macOS app')
  .example('  reviewroom wait acme/api#31')
  .action(run(forReview<StartOpts>('wait', cmdWait)));

cli
  .command('status [target]', 'Show review status and threads')
  .usage('status [id|number|URL|branch] [options]')
  .option('--threads', 'Include open threads and messages')
  .option('--all', 'Include resolved threads')
  .option('--json', 'Print JSON')
  .example('  reviewroom status acme/api#31 --json')
  .action(run(forReview<StatusOpts & { threads?: boolean }>('status', (repo, dir, o) => (o.threads ? cmdThreads(repo, { ...o, dir }) : cmdStatus(repo, dir, o)))));

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
  .command('slide-lint', 'Audit all or selected walkthrough slides')
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
  .command('publish-slides', 'Publish walkthrough slides to the PR')
  .option('--dry-run', 'Print without posting')
  .option('--allow-stale', 'Allow stale links; schema must pass')
  .example('  reviewroom publish-slides')
  .action(run(cmdPublishSlides));

cli
  .command('shot [section]', 'Capture report sections or chapter/step slides')
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

cli
  .command('list', 'List running review servers')
  .option('--json', 'Print a JSON array of running reviews')
  .example('  reviewroom list --json')
  .action(run<{ json?: boolean }>((_repo, o) => cmdList(o)));

cli
  .command('stop [target]', 'Stop a review server')
  .usage('stop [id|number|URL|branch] [options]')
  .example('  reviewroom stop acme/api#31')
  .action(run(forReview('stop', cmdStop)));

cli
  .command('hub [action]', 'Serve or stop the local review hub')
  .usage('hub <serve|stop> [options]')
  .option('--detach', 'Serve in background; print URL')
  .option('--stop', 'Alias for hub stop')
  .option('--port <n>', 'Port (default: 4847)')
  .option('--public-origin <url>', 'Save public HTTPS origin; none clears it')
  .option('--no-open', 'Do not open the browser')
  .example('  reviewroom hub serve --detach')
  .example('  reviewroom hub stop')
  .action(run<HubOpts>((_repo, o, [action = 'serve']) => {
    if (action !== 'serve' && action !== 'stop') die(`unknown hub action \`${action}\`; see \`reviewroom hub --help\``, 2);
    return cmdHub({ ...o, stop: o.stop || action === 'stop' });
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
  'pr': `  Loads available PR walkthroughs into missing ${WALKTHROUGH_FILE} files.
  Newest author-owned or agent-owned walkthrough wins.
  Prints the directory (stderr) and URL (stdout).
  Reuses a running server and keeps its revision. After stopping it, rerun pr to fetch updates.`,
  'start': `  Prints the review URL. Reuses a running server and its port.`,
  'list': `  Lists running reviews across repositories. The hub can be stopped.`,
  'wait': `  Starts a detached server if needed and leaves it running.
  Prints saved feedback or APPROVED to stdout and records delivery.`,
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
  const hiddenFlags = c === 'pr' ? /^(?:--detach|--wait)\b/ : /^(?:--foreground|--forever|--stop)\b/;
  // cac shows negated flags as '(default: true)', which reads as the opposite of what --no-open does
  const rows = sections.map((x) => x.title === 'Options'
    ? { ...x, body: x.body.split('\n').filter((line) => !hiddenFlags.test(line.trimStart())).join('\n').replace(/(Do not open the browser) \(default: true\)/g, '$1') }
    : x);
  if (c) return notes[c] ? [...rows, { title: 'Notes', body: notes[c] }] : rows;
  return [
    ...rows.map((x) => (x.title?.startsWith('For more info') ? { ...x, body: '  $ reviewroom <command> --help' } : x)),
    {
      title: 'A review',
      body: [
        '  pr acme/api#31: set up a review and start its server.',
        '  wait acme/api#31: await the next round in the background.',
        '  list: show running reviews and their URLs.',
        '  shot [section]: inspect PNG output.',
        '  reply <thread> "...": answer feedback.',
        '  stop acme/api#31: stop the review server.',
        '  The server stays up between rounds.',
      ].join('\n'),
    },
    {
      title: 'A walkthrough (when wanted)',
      body: [
        `  ${WALKTHROUGH_FILE} sits beside ${REPORT_FILE}.`,
        '  slide-lint: validate walkthrough slides.',
        '  shot <chapter>/<step>: inspect one slide.',
        '  publish-slides: publish to the PR.',
      ].join('\n'),
    },
    {
      title: 'The review dir',
      body: [
        '  ~/.reviewroom/reviews/; REVIEWROOM_HOME overrides the root.',
        '  Use a PR review ID (owner/repo#n) from any directory, or use a number, URL or branch in its repo.',
        "  With no target, they use the current branch or the repo's only review.",
        '  Use --dir for custom review directories.',
        `  Author ${REPORT_FILE}, ${WALKTHROUGH_FILE}, and adjacent assets.`,
        '  Change state, config, layouts, and rounds through CLI commands.',
      ].join('\n'),
    },
    {
      title: 'Experimental',
      body: [
        '  REVIEWROOM_ASSISTANT=1: an Assistant panel, a Claude Code chat on this machine (native login, Bun only).',
        '  Requires Git and a Claude login. First use downloads the pinned agent runtime; no global plugin, Node or pnpm needed.',
        '  Agent runtime/cache: ~/.reviewroom/assistant/ (under REVIEWROOM_HOME); Claude login/settings stay native.',
        '  claudeExecutable: optional executable name or path (relative to config.json). Restart after changing it.',
        '  Selection: config override, CLAUDE_CODE_EXECUTABLE, claude on PATH, then the bundled binary.',
        '  ~/.reviewroom/config.json: defaultAgentHarness (claude), defaultReviewModel (sonnet).',
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
  if (cli.matchedCommand) await cli.runMatchedCommand();
  else if (cli.args.length) die(`unknown command \`${cli.args[0]}\`; see \`reviewroom --help\``, 2);
  else if (!cli.options.help) cli.outputHelp();
} catch (e) {
  if ((e as Error).name === 'CACError') die(`${(e as Error).message}; see \`reviewroom ${cli.matchedCommandName ?? ''} --help\``.replace('  ', ' '), 2);
  if (!(e instanceof ReviewroomError)) throw e;
  die(e.message);
}
