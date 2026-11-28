// One conversation per review. AI SDK assembles the messages; the harness owns its opaque resume payload.
import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
import { reviewStore, type SavedAssistant } from './review-store.ts';

export type { SavedAssistant };

/** Like state.json: a corrupt file is moved aside and blocks the assistant (not the review) until restored or deleted. */
export function assistantStore(dir: string, repo: string) {
  const store = reviewStore(dir).assistant, file = store.file;
  const saved: SavedAssistant = store.read() ?? { version: 1, repo, messages: [], status: 'idle' };
  // Claude Code keeps its sessions per directory: another checkout of this branch can't continue this one
  if (saved.repo !== repo) {
    if (saved.session || saved.messages.length) throw new ReviewroomError(`This review's assistant conversation was started in ${saved.repo}. Open the review from there to continue it, or delete ${file} to start a new one here.`);
    saved.repo = repo;
  }
  return { file, saved, write: () => store.write(saved) };
}
