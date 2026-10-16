// The state.json contract and the ops that change it, defined once. The TS types (src/core/types.ts),
// runtime validation (ops in applyOp, state.json in the CLI) and schema/state.schema.json all come from here.
// No DOM or Node imports, so both the client bundle and the CLI can import it.
//
// State objects accept unknown keys (the JSON schema doesn't forbid them and the CLI keeps them on rewrite);
// timestamps are documented as date-time but checked as strings, so hand-written or older files still load.
import { z } from 'zod';

const nonEmpty = z.string().min(1, 'must be a non-empty string');
const int = z.number().int();
const dateTime = z.string().meta({ format: 'date-time' });

export const TextQuote = z.object({ exact: z.string(), prefix: z.string().optional(), suffix: z.string().optional() });

const CodeAnchor = z.object({ kind: z.literal('code'), path: z.string(), rev: z.enum(['base', 'head']), start: int, end: int });
export const Anchor = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('doc'),
    target: z.string().describe("Element id in the narrative ('' = review root)"),
    path: z.string().optional().describe('CSS path below the target for blocks without an id'),
    quote: TextQuote.optional(),
  }),
  CodeAnchor,
  z.object({ kind: z.literal('symbol'), name: z.string() }),
  z.object({ kind: z.literal('general') }),
]);

export const Author = z.enum(['you', 'agent']);
const CheckValue = z.enum(['todo', 'pass', 'fail']);

/** A message as stored in state.json (GitHub's comments are never stored there). */
export const StoredMessage = z.object({
  id: z.string(),
  author: Author,
  round: int,
  body: z.string().describe('Markdown. rr: links render as chips; ![](rr:...) as embeds.'),
  at: dateTime,
});

export const StoredThread = z.object({
  id: z.string(),
  anchor: Anchor,
  status: z.enum(['open', 'resolved']),
  createdRound: int,
  messages: z.array(StoredMessage),
  title: z.string().optional(),
});

export const Round = z.object({
  n: int,
  status: z.enum(['open', 'sent', 'approved']),
  startedAt: dateTime,
  sentAt: dateTime.optional(),
  note: z.string().optional(),
  deliveredAt: dateTime
    .nullable()
    .optional()
    .describe("When `reviewroom review` printed this round's feedback. null = finished but not yet delivered (the next `review` prints it). Absent on rounds finished before this field existed."),
});

export const StoredState = z.object({
  version: z.literal(1),
  rev: int.min(0).optional().describe('Bumped by every applied change (op). Missing = 0.'),
  round: int.min(1).describe('Current round. Agent replies are tagged with it.'),
  rounds: z.array(Round),
  threads: z.array(StoredThread),
  viewed: z.record(z.string(), int).default({}).describe('path -> round it was marked viewed'),
  pins: z.array(z.string()).default([]),
  checks: z.record(z.string(), CheckValue).optional(),
  links: z
    .record(z.string(), z.string())
    .optional()
    .describe('narrative rr: link -> fingerprint when first seen: hash of the lines for a line range, "definition" for a symbol (stale-link check)'),
});

const ghBody = z.string().trim().min(1, 'body must be a non-empty string');
/** POST /api/github: the reviewer acting on the PR's own GitHub threads (cli/lib/github.ts carries it out). */
export const GitHubAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('comment'), anchor: CodeAnchor, body: ghBody }),
  z.object({ action: z.literal('reply'), thread: z.string(), body: ghBody }),
  z.object({ action: z.literal('conversation'), body: ghBody }),
  z.object({ action: z.literal('edit'), message: z.string(), body: ghBody }),
  z.object({ action: z.literal('delete'), message: z.string() }),
  z.object({ action: z.literal('resolve'), thread: z.string(), resolved: z.boolean() }),
  z.object({ action: z.literal('submit'), event: z.enum(['comment', 'approve', 'request_changes']), body: z.string().optional() }),
  z.object({ action: z.literal('discard') }),
]);
export type GitHubAction = z.infer<typeof GitHubAction>;

/** Every change to the state, applied by applyOp in src/shared/ops.ts. `at` defaults to now. */
/** POST /api/finish is this op without `op`. */
export const FinishRound = z.object({ op: z.literal('finishRound'), kind: z.enum(['feedback', 'approve']), note: z.string().optional(), round: int.optional(), at: z.string().optional() });
export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createThread'), id: nonEmpty, anchor: Anchor, msgId: nonEmpty, body: nonEmpty, author: Author, at: z.string().optional() }),
  z.object({ op: z.literal('addMessage'), threadId: nonEmpty, id: nonEmpty, body: nonEmpty, author: Author, at: z.string().optional() }),
  z.object({ op: z.literal('editMessage'), threadId: nonEmpty, msgId: nonEmpty, body: nonEmpty }),
  z.object({ op: z.literal('deleteMessage'), threadId: z.string(), msgId: z.string() }),
  z.object({ op: z.literal('setThreadStatus'), threadId: nonEmpty, status: z.enum(['open', 'resolved']) }),
  z.object({ op: z.literal('setViewed'), path: nonEmpty, viewed: z.boolean() }),
  z.object({ op: z.literal('setPin'), ref: nonEmpty, pinned: z.boolean() }),
  z.object({ op: z.literal('setCheck'), id: nonEmpty, value: CheckValue }),
  z.object({ op: z.literal('setLinks'), links: z.record(z.string(), z.string()) }),
  FinishRound,
  z.object({ op: z.literal('markDelivered'), round: int, at: z.string().optional() }),
]);

export type TextQuote = z.infer<typeof TextQuote>;
export type Anchor = z.infer<typeof Anchor>;
export type Author = z.infer<typeof Author>;
export type StoredMessage = z.infer<typeof StoredMessage>;
export type StoredThread = z.infer<typeof StoredThread>;
export type Round = z.infer<typeof Round>;
export type StoredState = z.infer<typeof StoredState>;
export type Op = z.infer<typeof Op>;

/** Zod's issues as one line: `path: message; ...`. */
export const issueText = (e: z.core.$ZodError) => e.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

/** schema/state.schema.json, generated (scripts/schema.ts writes it; a test fails when the committed file is stale). */
export const stateJsonSchema = () => ({
  ...z.toJSONSchema(StoredState, { target: 'draft-2020-12', io: 'input' }),
  $id: 'reviewroom/state.schema.json',
  title: 'reviewroom review state (.reviewroom/<branch>/state.json)',
});
