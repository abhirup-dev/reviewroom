import { expect, test } from 'bun:test';
import { walkthroughFilename } from './walkthrough-export.ts';

const pr = 'acme/api#31';
const prefix = 'a'.repeat(86);
const longId = prefix + 'x'.repeat(20);

test.each([
  ['slugging', 'acme/api/feat/rate-limit', 'D\u00e9j\u00e0 vu! "Uploads?" / \u6771\u4eac', 'acme-api-feat-rate-limit-deja-vu-uploads.html'],
  ['word boundary', pr, 'upload '.repeat(30), 'acme-api-31-' + Array<string>(12).fill('upload').join('-') + '.html'],
  ['one long word', pr, 'a'.repeat(200), 'acme-api-31-' + 'a'.repeat(83) + '.html'],
  ['oversized review ID', longId, 'Ignored title', prefix + '-5dff0762.html'],
  ['oversized ID with the same prefix', longId + 'y', 'Ignored title', prefix + '-1e1b9413.html'],
])('walkthrough filename handles %s', (_case, id, title, expected) => {
  const filename = walkthroughFilename(id, title);
  expect(filename).toBe(expected);
  expect(filename.length).toBeLessThanOrEqual(100);
});
