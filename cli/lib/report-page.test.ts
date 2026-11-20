import { expect, test } from 'bun:test';
import { reportPage } from './report-page.ts';

const ENTRY = '<script type="module" src="_rr/reviewroom.js"></script>';
const inHead = (page: string, s: string) => page.indexOf(s) >= 0 && page.indexOf(s) < page.indexOf('</head>');

test.each([
  ['just the writing', '<h1>Hi</h1>'],
  ['the writing in <rr-review>', '<rr-review>\n<h1>Hi</h1>\n</rr-review>'],
  ['the <rr-app> form older skills documented', '<rr-app>\n<rr-review>\n<h1>Hi</h1>\n</rr-review>\n</rr-app>'],
  ['a whole page', '<!doctype html><html><head><script type="module" src="/_rr/reviewroom.js"></script></head><body><rr-app><rr-review><h1>Hi</h1></rr-review></rr-app></body></html>'],
])('%s boots: one client entry in the head, the writing once inside <rr-review> inside <rr-app>', (_, report) => {
  const page = reportPage(report);
  expect(inHead(page, ENTRY)).toBe(true);
  expect(page.split('_rr/reviewroom.js').length).toBe(2);
  expect(inHead(page, 'rel="manifest"')).toBe(true);
  expect(page.match(/<rr-app>/g)).toHaveLength(1);
  expect(page.match(/<rr-review>/g)).toHaveLength(1);
  expect(page.indexOf('<rr-app>')).toBeLessThan(page.indexOf('<rr-review>'));
  expect(page.slice(page.indexOf('<rr-review>'), page.indexOf('</rr-review>'))).toContain('<h1>Hi</h1>');
});

test('no report yet: the shell with an empty report', () => expect(reportPage('')).toContain('<rr-app>\n<rr-review>\n\n</rr-review>\n</rr-app>'));
