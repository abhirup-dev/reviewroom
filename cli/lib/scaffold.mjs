import fs from 'node:fs';
import path from 'node:path';
import { flags } from './args.mjs';
import { makeProvider } from './git.mjs';
import { PKG } from './server.mjs';

export function scaffold(repo, dir, cfg) {
  const target = path.join(dir, 'review.html');
  if (fs.existsSync(target) && !flags.force) return false;
  const prov = makeProvider(repo, cfg);
  const meta = prov.meta();
  const files = prov.files(prov.base, prov.head);
  let html = fs.readFileSync(path.join(PKG, 'templates', 'review.html'), 'utf8');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const list = files.map((f) => `          <li><rr-ref ref="rr:code/${esc(f.path)}"></rr-ref> — ${f.status}, +${f.additions} −${f.deletions}</li>`).join('\n');
  // function replacers: `$&`, `$'` in titles/paths must stay literal
  html = html.replaceAll('{{TITLE}}', () => esc(meta.title)).replace('{{FILES}}', () => list);
  fs.writeFileSync(target, html);
  return true;
}
