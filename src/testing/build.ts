// Test data with valid defaults: override only what the test is about.
import { emptyState, type Anchor, type Message, type ReviewState, type Thread } from '../kernel/state/model.shared';

const at = '2026-01-01T00:00:00.000Z';

export const build = {
  anchor: {
    general: (): Anchor => ({ kind: 'general' }),
    code: (path = 'a.ts', start = 1, end = start): Anchor => ({ kind: 'code', path, rev: 'head', start, end }),
    doc: (target = 'intro'): Anchor => ({ kind: 'doc', target }),
    tour: (chapter: string, step: string): Anchor => ({ kind: 'tour', chapter, step }),
  },
  message: (over: Partial<Message> = {}): Message => ({ id: 'm_1', author: 'you', round: 1, body: 'unclear', at, ...over }),
  /** An open thread with one reviewer message (its id `m<thread id>`). */
  thread: (id: string, over: Partial<Thread> = {}): Thread => ({
    id, anchor: { kind: 'general' }, status: 'open', createdRound: 1, messages: [build.message({ id: 'm' + id })], ...over,
  }),
  state: (over: Partial<ReviewState> = {}): ReviewState => ({ ...emptyState(), ...over }),
};
