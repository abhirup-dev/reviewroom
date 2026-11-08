import { expect, test } from 'bun:test';
import { diff } from './snapshot.ts';

const el = (fontSize: string) => ({ 'font-size': fontSize });

test('diff reports changed properties, new and gone elements, per state', () => {
  const a = { 'phone/light/start': { 'body>p:0': el('13px'), 'body>i:1': el('12px') } };
  const b = { 'phone/light/start': { 'body>p:0': el('14px'), 'body>b:2': el('12px') } };
  expect(diff(a, b)).toEqual([
    'phone/light/start  1x  font-size: 13px -> 14px (p)',
    'phone/light/start  1x  gone: i',
    'phone/light/start  1x  new: b',
  ]);
  expect(diff(a, a)).toEqual([]);
});
