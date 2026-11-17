// One conversation per review. AI SDK assembles the messages; the harness owns its opaque resume payload.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import type { HarnessAgentResumeSessionState } from '@ai-sdk/harness/agent';

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

export function assistantStore(dir: string, repo: string) {
  const file = path.join(dir, 'assistant.json');
  const empty: SavedAssistant = { version: 1, repo, messages: [] };
  const saved = fs.existsSync(file) ? SavedAssistant.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : empty;
  if (saved.repo !== repo) throw new Error(`The saved assistant belongs to another repository: ${file}`);
  return {
    saved,
    write() {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
