// The portable walkthrough and the exact Git blobs it can open. No browser or CLI dependencies.
import { z } from 'zod';
import { Walkthrough } from './model.shared';

export const CommitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const WalkthroughBundle = z.object({
  version: z.literal(1),
  walkthrough: Walkthrough,
  source: z.object({
    repo: z.string().optional(),
    pr: z.union([z.number(), z.string()]).optional(),
    title: z.string(),
    author: z.string().optional(),
    base: CommitSha,
    head: CommitSha,
    baseLabel: z.string().optional(),
    headLabel: z.string().optional(),
    exportedAt: z.iso.datetime(),
  }),
  files: z.array(z.object({
    path: z.string(),
    prevPath: z.string().optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean().optional(),
  })),
  contents: z.record(z.string(), z.string()),
});

export type WalkthroughBundle = z.infer<typeof WalkthroughBundle>;
