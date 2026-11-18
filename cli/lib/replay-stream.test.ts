import { expect, test } from 'bun:test';
import { replayStream } from './replay-stream';

const reader = (res: Response) => res.body!.pipeThrough(new TextDecoderStream()).getReader();
/** Everything the reader gets until the stream ends. */
async function rest(r: ReadableStreamDefaultReader<string>) {
  let all = '';
  for (let x = await r.read(); !x.done; x = await r.read()) all += x.value;
  return all;
}

test('a follower gets what was said, then the rest, once each and in order; one that leaves stops only itself; close ends every reader and keeps nothing', async () => {
  const s = replayStream({ 'content-type': 'text/event-stream' });
  s.say('a');
  const res = s.follow();
  const gone = reader(s.follow());
  const idle = reader(s.follow());
  s.say('b');
  await gone.cancel();
  s.say('c');
  s.close();
  s.say('late');
  expect([res.headers.get('content-type'), await rest(reader(res)), await rest(idle), await rest(reader(s.follow()))]).toEqual(['text/event-stream', 'abc', 'abc', '']);
});
