import { expect, test } from 'bun:test';
import { Streams } from './streams.ts';

const stream = () => {
  const got: string[] = [];
  return { got, writeSSE: async ({ event, data }: { event: string; data: string }) => void got.push(`${event}:${JSON.parse(data).s ?? ''}`) };
};

test('a stream that connected between broadcasts still gets the change back to an earlier state', () => {
  const s = new Streams<ReturnType<typeof stream>>();
  const a = stream();
  s.add(a, () => [['progress', { s: 'idle' }]]);
  s.send('progress', { s: 'idle' }); // the same again: once
  const b = stream();
  s.add(b, () => [['progress', { s: 'requested' }]]); // a request appended, not broadcast yet
  s.send('progress', { s: 'requested' });
  s.send('progress', { s: 'idle' }); // a reset: equal to the last broadcast before b connected
  expect(a.got).toEqual(['progress:idle', 'progress:requested', 'progress:idle']);
  expect(b.got).toEqual(['progress:requested', 'progress:idle']);
});

test('a snapshot that throws registers nothing; other events always go through', () => {
  const s = new Streams<ReturnType<typeof stream>>();
  const a = stream();
  expect(() => s.add(a, () => { throw new Error('EACCES'); })).toThrow('EACCES');
  expect(s.size).toBe(0);
  s.add(a, () => [['hello', {}]]);
  s.send('state', { s: 'x' });
  s.send('state', { s: 'x' });
  expect(a.got).toEqual(['hello:', 'state:x', 'state:x']);
  s.delete(a);
  expect(s.size).toBe(0);
});
