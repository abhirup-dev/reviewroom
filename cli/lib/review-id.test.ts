import { expect, test } from 'bun:test';
import path from 'node:path';
import { reviewsDir } from './paths.ts';
import { formatReviewId, idFromFolder, parseReviewId, reviewFolder } from './review-id.ts';

test('PR IDs round-trip through their canonical folders', () => {
  const cases = [
    ['ACME/api_v2#031', 'acme/api_v2#31', 'acme_api_v2'],
    ['a-b/c#31', 'a-b/c#31', 'a-b_c'],
    ['https://github.com/a/b-c/pull/31#discussion', 'a/b-c#31', 'a_b-c'],
  ];
  for (const [input, expected, bucket] of cases) {
    const id = parseReviewId(input);
    const dir = reviewFolder(id);
    expect(formatReviewId(id)).toBe(expected);
    expect(dir).toBe(path.resolve(reviewsDir(), bucket, 'pulls', '31'));
    expect(idFromFolder(dir)).toEqual(id);
  }
});
