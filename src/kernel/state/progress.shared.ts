import { z } from 'zod';

const facts = { head: z.string().optional(), slides: z.number().int().nonnegative().optional(), chapters: z.number().int().nonnegative().optional(), source: z.literal('pr').optional() };
const identity = { at: z.iso.datetime(), artifact: z.enum(['walkthrough', 'report']), ...facts };
export const ProgressLine = z.discriminatedUnion('event', [
  z.object({ ...identity, event: z.literal('requested') }),
  z.object({ ...identity, event: z.enum(['written', 'validated']), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type ProgressLine = z.infer<typeof ProgressLine>;
export type Artifact = ProgressLine['artifact'];
export type ArtifactProgress = { state: 'none' | ProgressLine['event']; hash?: string; slides?: number; chapters?: number };
export type Progress = Record<Artifact, ArtifactProgress>;
export const pendingArtifact = (p: ArtifactProgress) => p.state === 'requested' || p.state === 'written';

/** Ignore incomplete/malformed lines (including a writer's unfinished final append). */
export function parseProgress(text: string): ProgressLine[] {
  return text.split('\n').flatMap((line) => {
    try { const r = ProgressLine.safeParse(JSON.parse(line)); return r.success ? [r.data] : []; } catch { return []; }
  });
}
export function reduceProgress(lines: ProgressLine[], hashes: Partial<Record<Artifact, string>>): Progress {
  const result: Progress = { walkthrough: { state: 'none' }, report: { state: 'none' } };
  for (const line of lines) {
    if (line.event !== 'requested' && result[line.artifact].state === 'none') continue;
    result[line.artifact] = { ...line, state: line.event === 'validated' && line.hash !== hashes[line.artifact] ? 'written' : line.event };
  }
  return result;
}
