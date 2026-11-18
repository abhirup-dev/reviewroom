import { expect, test } from 'bun:test';
import { replayStream } from './replay-stream';

const reader = (res: Response) => res.body!.pipeThrough(new TextDecoderStream()).getReader();
/** Everything the reader gets until the stream ends. */
async function rest(r: ReadableStreamDefaultReader<string>) {
  let all = '';
  for (let x = await r.read(); !x.done; x = await r.read()) all += x.value;
  return all;
}

test('a follower gets what was said, then what is said after, once each and in order; then the end', async () => {
  const s = replayStream({ 'content-type': 'text/event-stream' });
  s.say('a');
  const res = s.follow();
  s.say('b');
  s.say('c');
  s.close();
  expect([res.headers.get('content-type'), await rest(reader(res))]).toEqual(['text/event-stream', 'abc']);
});

test('a reader that leaves only stops reading: the others go on', async () => {
  const s = replayStream({});
  const gone = reader(s.follow());
  const stays = reader(s.follow());
  s.say('a');
  await gone.cancel();
  s.say('b');
  s.close();
  expect(await rest(stays)).toBe('ab');
});

test('close ends every reader, including one that never read, and keeps nothing: a later follower gets an empty end', async () => {
  const s = replayStream({});
  s.say('a');
  const idle = reader(s.follow());
  s.close();
  s.say('late');
  expect([await rest(idle), await rest(reader(s.follow()))]).toEqual(['a', '']);
});
