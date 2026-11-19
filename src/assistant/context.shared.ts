// What the reviewer attaches to a question (rr-2l7): a review link, its description and a brief excerpt. It travels as
// assistant-ui's composer quote (the user message's metadata.custom.quote), so the chip, its removal and its freezing
// at send belong to the library; the server checks it here and puts it before the question it was sent with.
import { z } from 'zod';
import { formatRef, parseRef } from '../kernel/refs/refs.shared';
import type { Anchor } from '../kernel/state/schema.shared';

const MAX_LINES = 40;
export const MAX_EXCERPT = 4000;
/** The response header naming the turn a stream is (its `activeStreamId`): a page knows what it attached to. */
export const TURN_HEADER = 'x-reviewroom-turn';

/** A quote the assistant takes: assistant-ui's QuoteInfo (text, messageId) plus the link and its description. */
export const AskContext = z.object({
  text: z.string().max(MAX_EXCERPT),
  messageId: z.string().max(200),
  ref: z.string().max(1000).refine((r) => ['code', 'doc'].includes(parseRef(r)?.type ?? ''), 'not a code or walkthrough link'),
  label: z.string().max(300),
});
export type AskContext = z.infer<typeof AskContext>;

/** UI message metadata as the assistant reads it: anything, with a valid quote when there is one. */
export const AskMetadata = z.looseObject({ custom: z.looseObject({ quote: AskContext.optional() }).optional() }).optional();

/** Pin the displayed revision when attaching code, even if the reader switches ranges before sending. */
export function askRef(anchor: Extract<Anchor, { kind: 'code' | 'doc' }>, range: { key: string; base: string; head: string }) {
  if (anchor.kind === 'doc') return formatRef({ type: 'doc', id: anchor.target, path: anchor.path });
  const rev = range[anchor.rev];
  return formatRef({ type: 'code', path: anchor.path, rev, start: anchor.start, end: anchor.end });
}

/** The selected lines of a file's text, capped. */
export const excerptLines = (text: string, start: number, end: number) =>
  text.split('\n').slice(start - 1, Math.min(end, start + MAX_LINES - 1)).join('\n').slice(0, MAX_EXCERPT);

/** What the agent reads before the question. `revs`: the commits base and head stood at when it was sent. */
export function contextPrompt(c: AskContext, revs: { base: string; head: string }) {
  const r = parseRef(c.ref);
  const at = r?.type === 'code' ? ` (${r.rev === 'head' || r.rev === 'base' ? `${r.rev} = ${revs[r.rev]}` : `commit ${r.rev}`})` : '';
  const quote = c.text.trim() ? `\n\`\`\`\`\n${c.text}\n\`\`\`\`` : '';
  return `The reviewer asks about ${c.label}: ${c.ref}${at}.${quote}\n\n`;
}
