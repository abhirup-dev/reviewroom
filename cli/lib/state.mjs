// Review dir, config.json, state.json and rr: anchors.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { flags, pos, die } from './args.mjs';
import { git, defaultBase } from './git.mjs';

export function resolveDir(repo) {
  if (flags.dir) return path.resolve(flags.dir);
  const p = pos.find((x) => fs.existsSync(x) && fs.statSync(x).isDirectory());
  if (p) return path.resolve(p);
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], repo, { soft: true }) || 'review').trim().replace(/[^\w.-]+/g, '-');
  return path.join(repo, '.readingroom', branch);
}

export function loadConfig(dir, repo) {
  const file = path.join(dir, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const k of ['base', 'head', 'title', 'repo-name', 'number', 'author', 'url']) if (typeof flags[k] === 'string') cfg[k === 'repo-name' ? 'repo' : k] = flags[k];
  cfg.base ||= defaultBase(repo);
  cfg.head ||= 'HEAD';
  return cfg;
}

const emptyState = () => ({ version: 1, round: 1, rounds: [{ n: 1, status: 'open', startedAt: new Date().toISOString() }], threads: [], viewed: {}, pins: [] });
export const statePath = (dir) => path.join(dir, 'state.json');
export function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return emptyState();
  }
}
export function writeState(dir, s) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = statePath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, statePath(dir));
}
export const uid = (p) => p + crypto.randomBytes(4).toString('hex');

export const dirForEdit = (repo) => {
  if (!repo && !flags.dir) die('not inside a git repository (use --dir)');
  return flags.dir ? path.resolve(flags.dir) : resolveDir(repo);
};


export function parseAnchor(ref) {
  const m = ref.match(/^rr:(\w+)\/(.*)$/);
  if (!m) return { kind: 'general' };
  const [, type, rest] = m;
  if (type === 'doc') {
    const [id, ...p] = rest.split('/');
    return { kind: 'doc', target: decodeURIComponent(id), path: p.length ? decodeURIComponent(p.join('/')) : undefined };
  }
  if (type === 'code') {
    const lm = rest.match(/#L(\d+)(?:-L?(\d+))?$/);
    let p = lm ? rest.slice(0, lm.index) : rest;
    let rev = 'head';
    const at = p.lastIndexOf('@');
    if (at > 0) (rev = p.slice(at + 1)), (p = p.slice(0, at));
    return { kind: 'code', path: p, rev: rev === 'base' ? 'base' : 'head', start: lm ? +lm[1] : 1, end: lm ? +(lm[2] || lm[1]) : 1 };
  }
  if (type === 'sym') return { kind: 'symbol', name: decodeURIComponent(rest) };
  return { kind: 'general' };
}
