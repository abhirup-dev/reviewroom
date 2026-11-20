import { expect, test } from 'bun:test';
import { formatReviewId } from './review-id.ts';
import { walkthroughFilename } from './walkthrough-export.ts';

test('walkthrough filenames use the review identity and slugged title', () => {
  const pr = formatReviewId({ owner: 'acme', repo: 'api', number: 31 });
  expect(walkthroughFilename(pr, 'Limit file uploads per account')).toBe('acme-api-31-limit-file-uploads-per-account.html');
  expect(walkthroughFilename('acme/api/feat/rate-limit', 'D\u00e9j\u00e0 vu! "Uploads?" / \u6771\u4eac')).toBe('acme-api-feat-rate-limit-deja-vu-uploads.html');
});

test('long titles stop at a word boundary or fit a single word to the cap', () => {
  const id = 'acme/api#31';
  expect(walkthroughFilename(id, 'upload '.repeat(30))).toBe('acme-api-31-' + Array<string>(12).fill('upload').join('-') + '.html');
  expect(walkthroughFilename(id, 'a'.repeat(200))).toBe('acme-api-31-' + 'a'.repeat(83) + '.html');
});

test('an oversized review identity uses its prefix and a hash of the full ID', () => {
  const prefix = 'a'.repeat(86);
  const id = prefix + 'x'.repeat(20);
  expect(walkthroughFilename(id, 'Ignored title')).toBe(prefix + '-5dff0762.html');
  expect(walkthroughFilename(id + 'y', 'Ignored title')).toBe(prefix + '-1e1b9413.html');
});
