// Build a single self-contained demo page (no server): static provider + fixture
// generated from a git repo + an example review + seeded threads.
//
//   node scripts/build-demo.mjs <repo> <base> <head> <example-dir> <out.html> [--fragment]
//
// --fragment omits <!doctype>/<html>/<head>/<body> (for hosts that wrap the page themselves).
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [repo, baseRef, headRef, exampleDir, out] = process.argv.slice(2);
const fragment = process.argv.includes('--fragment');
if (!out) throw new Error('usage: build-demo.mjs <repo> <base> <head> <example-dir> <out.html> [--fragment]');

// 1) bundle without code-splitting, keeping only a handful of grammars
const KEEP = new Set(['go', 'sql', 'proto', 'protobuf', 'typescript', 'javascript', 'tsx', 'json', 'yaml', 'python', 'markdown', 'shellscript', 'bash', 'html', 'css', 'diff']);
const stub = {
  name: 'stub-shiki',
  setup(b) {
    b.onResolve({ filter: /^@shikijs\/(langs|themes)\/[\w-]+$/ }, (a) => {
      const [, kind, name] = a.path.match(/^@shikijs\/(langs|themes)\/([\w-]+)$/);
      if (kind === 'langs' && KEEP.has(name)) return null;
      return { path: a.path, namespace: 'stub' };
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default []', loader: 'js' }));
  },
};
const css = ['dockview-base', 'tokens', 'shell', 'panels', 'overlays', 'content', 'dockview'].map((f) => fs.readFileSync(`src/styles/${f}.css`, 'utf8')).join('\n');
const cssPlugin = {
  name: 'rr-css',
  setup(b) {
    b.onResolve({ filter: /^virtual:rr-css$/ }, () => ({ path: 'x', namespace: 'rrcss' }));
    b.onLoad({ filter: /.*/, namespace: 'rrcss' }, () => ({ contents: `export default ${JSON.stringify(css)}`, loader: 'js' }));
  },
};
const res = await esbuild.build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', splitting: false, write: false, minify: true, target: 'es2022', legalComments: 'none', plugins: [stub, cssPlugin] });
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

// 2) fixture from git
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const rev = (r) => git('rev-parse', r).trim();
const head = rev(headRef);
const base = git('merge-base', rev(baseRef), head).trim();
const commits = git('log', '--reverse', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', `${base}..${head}`).trim().split('\n').filter(Boolean).map((l) => {
  const [sha, short, subject, author, date] = l.split('\x1f');
  return { sha, short, subject, author, date };
});
const filesFor = (b, h) => {
  const st = git('diff', '--name-status', '-M', b, h).trim().split('\n').filter(Boolean);
  const num = git('diff', '--numstat', '-M', b, h).trim().split('\n').filter(Boolean);
  return st.map((l, i) => {
    const [s, p1, p2] = l.split('\t');
    const [a, d] = num[i].split('\t');
    return { path: p2 || p1, prevPath: p2 ? p1 : undefined, status: { A: 'added', D: 'deleted', R: 'renamed' }[s[0]] || 'modified', additions: +a || 0, deletions: +d || 0 };
  });
};
const files = { all: filesFor(base, head), [`${base}..${head}`]: filesFor(base, head) };
const contents = {};
const grab = (r, p) => {
  try {
    contents[`${r}:${p}`] = git('show', `${r}:${p}`);
  } catch {}
};
for (const f of files.all) {
  grab(base, f.prevPath || f.path);
  grab(head, f.path);
}
for (const c of commits) {
  const parent = rev(c.sha + '^');
  const fs_ = filesFor(parent, c.sha);
  files[`${c.sha}^..${c.sha}`] = fs_;
  for (const f of fs_) {
    grab(parent, f.prevPath || f.path);
    grab(c.sha, f.path);
    contents[`${c.sha}^:${f.prevPath || f.path}`] = contents[`${parent}:${f.prevPath || f.path}`];
  }
}
// a couple of untouched files so symbol search can leave the diff
for (const p of git('ls-tree', '-r', '--name-only', head).split('\n').filter(Boolean)) if (!contents[`${head}:${p}`]) grab(head, p);
const meta = { title: git('log', '-1', '--format=%s', head).trim(), repo: 'sharechat/moj-feed-aggregator-service', author: git('log', '-1', '--format=%an', head).trim(), base, head, baseLabel: baseRef, headLabel: headRef };
const fixture = { meta, commits, files, contents };

// 3) page
const review = fs.readFileSync(path.join(exampleDir, 'review.html'), 'utf8');
const state = fs.readFileSync(path.join(exampleDir, 'state.json'), 'utf8');
const pick = (re) => (review.match(re) || [, ''])[1];
const style = pick(/<style>([\s\S]*?)<\/style>/);
let app = pick(/(<rr-app[\s\S]*<\/rr-app>)/).replace('<rr-app>', '<rr-app provider="static">');
const json = (id, data) => `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
app = app.replace('</rr-app>', `${json('rr-fixture', fixture)}\n${json('rr-state', JSON.parse(state))}\n</rr-app>`);
const fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap">';
const body = `${fonts}\n<style>${style}</style>\n${app}\n<script type="module">${js}</script>`;
const html = fragment ? `<title>Readingroom</title>\n${body}` : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Readingroom demo</title></head><body>${body}</body></html>`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024 / 1024).toFixed(2)} MB (js ${(js.length / 1024 / 1024).toFixed(2)} MB)`);
