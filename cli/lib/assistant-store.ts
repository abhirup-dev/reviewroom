// One conversation per review. AI SDK assembles the messages; the harness owns its opaque resume payload.
import path from 'node:path';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { moveAside, readUnlessAside, writeAtomic } from './state.ts';

const SavedAssistant = z.object({
  version: z.literal(1),
  repo: z.string(),
  messages: z.array(z.custom<UIMessage>()),
  session: z.object({
    id: z.string(), sandboxId: z.string(),
    resume: z.custom<HarnessAgentResumeSessionState>(), // validated by the harness when resumed
  }).optional(),
});
export type SavedAssistant = z.infer<typeof SavedAssistant>;

/** Like state.json: a corrupt file is moved aside and blocks the assistant (not the review) until restored or deleted. */
export function assistantStore(dir: string, repo: string) {
  const file = path.join(dir, 'assistant.json');
  const raw = readUnlessAside(file);
  let saved: SavedAssistant = { version: 1, repo, messages: [] };
  if (raw !== null) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      moveAside(file, true, `is not valid JSON (${(e as Error).message})`);
    }
    const checked = SavedAssistant.safeParse(data);
    if (!checked.success) moveAside(file, true, 'is not a saved assistant conversation');
    saved = checked.data;
  }
  // Claude Code keeps its sessions per directory: another checkout of this branch can't continue this one
  if (saved.repo !== repo) {
    if (saved.session || saved.messages.length) throw new ReviewroomError(`This review's assistant conversation was started in ${saved.repo}. Open the review from there to continue it, or delete ${file} to start a new one here.`);
    saved.repo = repo;
  }
  return { file, saved, write: () => writeAtomic(file, JSON.stringify(saved), 0o600) };
}
