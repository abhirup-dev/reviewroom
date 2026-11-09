import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRev, git, WORKTREE } from '../git';

export type SourceFile = { path: string; absolute: string };
type Snapshot = { root: string; repo: string; revision: string; files: SourceFile[]; excluded: string[]; skipped: string[] };
type Save = (p: string, content: Buffer) => void;

function worktree(s: Snapshot, save: Save) {
  const names = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], s.repo).split('\0').filter(Boolean));
  for (const p of names) {
    try {
      const full = fs.realpathSync(path.join(s.repo, p));
      if (!full.startsWith(s.repo + path.sep) || !fs.statSync(full).isFile()) { s.skipped.push(p); continue; }
      save(p, fs.readFileSync(full));
    } catch { s.skipped.push(p); }
  }
}

function commit(s: Snapshot, save: Save) {
  const entries = git(['ls-tree', '-r', '-z', s.revision], s.repo).split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t'), p = entry.slice(tab + 1), [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (type !== 'blob' || mode === '120000') { s.skipped.push(p); return []; }
    return [{ path: p, oid }];
  });
  if (!entries.length) return;
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: s.repo, input: entries.map((e) => e.oid + '\n').join(''), maxBuffer: 256 * 1024 * 1024 });
  let offset = 0;
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset), size = Number(bytes.subarray(offset, end).toString().split(' ')[2]);
    if (end < 0 || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= bytes.length) throw new Error('invalid git blob response');
    save(entry.path, bytes.subarray(end + 1, end + 1 + size));
    offset = end + 1 + size + 1;
  }
}

/** Capture exact bytes without checking out a revision or applying archive export-ignore/export-subst attributes. */
export async function withSnapshot<T>(repo: string, revision: string, use: (s: Snapshot) => Promise<T>): Promise<T> {
  const real = fs.realpathSync(repo), rev = revision === WORKTREE ? WORKTREE : git(['rev-parse', checkRev(revision)], real).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-source-'));
  const root = path.join(dir, 'tree');
  fs.mkdirSync(root);
  const snapshot: Snapshot = { root, repo: real, revision: rev, files: [], excluded: [], skipped: [] };
  const save: Save = (p, content) => {
    if (content.subarray(0, 8000).includes(0)) { snapshot.excluded.push(p); return; }
    const absolute = path.join(root, p);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    snapshot.files.push({ path: p, absolute });
  };
  try {
    if (rev === WORKTREE) worktree(snapshot, save);
    else commit(snapshot, save);
    return await use(snapshot);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
