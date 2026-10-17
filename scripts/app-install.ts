// Builds the macOS app (app/) and installs it as ~/Applications/Reviewroom.app; `reviewroom` then opens
// reviews there. A local build is not quarantined, so it needs no Apple signing. Skipped off macOS or without Rust.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(import.meta.dir, '..');
if (process.platform !== 'darwin') process.exit(0);
if (spawnSync('cargo', ['--version']).status !== 0) {
  console.error('reviewroom: no Rust toolchain (https://rustup.rs), so no macOS app; reviews open in the browser');
  process.exit(0);
}
const run = (cmd: string, args: string[], cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('bunx', ['tauri', 'build'], path.join(root, 'app'));
const built = path.join(root, 'app/target/release/bundle/macos/Reviewroom.app');
const dest = path.join(os.homedir(), 'Applications', 'Reviewroom.app');
const isRunning = () => spawnSync('pgrep', ['-f', 'Reviewroom.app/Contents/MacOS/']).status === 0;
const running = isRunning();
if (running) spawnSync('osascript', ['-e', 'quit app id "dev.reviewroom.mac"']); // a running copy keeps the old build
for (let i = 0; i < 50 && isRunning(); i++) Bun.sleepSync(100); // else `open` below reaches the copy still quitting
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
run('ditto', [built, dest]);
// `open -b` (how reviewroom launches it) must find the installed copy, not the build folder's
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
spawnSync(lsregister, ['-u', built]);
spawnSync(lsregister, ['-f', dest]);
if (running) spawnSync('open', ['-g', dest]); // in the background; it reopens a tab for each running review
console.error(`reviewroom: installed ${dest}`);
