import fs from 'node:fs';
import path from 'node:path';
import { type Global, fail } from '../lib/args.ts';
import { exportWalkthrough } from '../lib/walkthrough-export.ts';

type ExportOptions = Global & { out?: string; allowStale?: boolean };

export async function cmdExport(repo: string | null, dir: string, options: ExportOptions) {
  const checkout = repo ?? fail('not inside a git repository (use --repo)');
  const { html, filename } = await exportWalkthrough(checkout, dir, options.allowStale);
  const output = path.resolve(options.out ?? filename);
  fs.writeFileSync(output, html);
  console.log(output);
}
