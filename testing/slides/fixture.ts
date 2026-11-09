// All slide browser tests share the existing demo-repo setup.
import { beforeEach } from 'bun:test';
import path from 'node:path';
import { setup } from '../../e2e/fixture.ts';
import { slideCases, writeSlideCase } from './cases.ts';

export const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));
export function setupSlides(adversarial = false) {
  const fixture = setup(), file = path.join(fixture.dir, 'walkthrough.json');
  beforeEach(() => writeSlideCase(fixture.dir, adversarial ? slideCases.audit : slideCases.demo));
  return { ...fixture, file };
}
