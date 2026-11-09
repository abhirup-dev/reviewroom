// Validate persisted benchmark files and CLI replies with the production contracts.
import { z } from 'zod';
import { Finding, Measured } from '../../cli/lib/slide-lint.ts';
import { LinkResult } from '../../cli/lib/links.ts';

export const Report = z.looseObject({ engine: z.string().min(1), viewports: z.array(z.string()).min(1), links: z.array(LinkResult), findings: z.array(Finding) });
const ms = z.number().nonnegative();
const code = z.union([z.literal(0), z.literal(1)]);
const CliRun = z.object({ ms, code, result: Report });
const Sample = z.object({
  checkMs: ms, renderMs: ms, bootMs: ms, auditMs: ms, cliMs: ms, cliCode: code,
  engine: z.string().min(1), measurements: z.array(Measured).min(1), findings: Report,
});
export const Benchmark = z.object({
  version: z.literal(1), revision: z.string(), sourceHash: z.string(), build: z.object({ id: z.string() }),
  bun: z.string(), platform: z.string(), cpu: z.string(), fixtureHash: z.string(), viewports: z.array(z.string()).min(1),
  cases: z.record(z.string(), z.array(Sample).min(1)).refine((cases) => Object.keys(cases).length > 0, 'needs benchmark cases'),
  scoped: z.record(z.string(), z.record(z.string(), z.object({ args: z.array(z.string()), runs: z.array(CliRun).min(1) }))).optional(),
});
export type Benchmark = z.infer<typeof Benchmark>;
export type CliRun = z.infer<typeof CliRun>;
export type Sample = z.infer<typeof Sample>;
