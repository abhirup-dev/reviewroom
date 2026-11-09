// All slide browser tests share the existing demo-repo setup.
import { beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from '../../e2e/fixture.ts';
import { auditReview, auditWalkthrough } from './cases.ts';

export const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
export function setupSlides(adversarial = false) {
  const fixture = setup(), file = path.join(fixture.dir, 'walkthrough.json');
  const demo = path.join(import.meta.dir, '../../examples/habit-events');
  beforeEach(() => {
    fs.writeFileSync(file, adversarial ? JSON.stringify(auditWalkthrough) : fs.readFileSync(path.join(demo, 'walkthrough.json')));
    fs.writeFileSync(path.join(fixture.dir, 'review.html'), adversarial ? auditReview : fs.readFileSync(path.join(demo, 'review.html')));
  });
  return { ...fixture, file };
}
