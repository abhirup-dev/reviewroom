import { ReviewroomError } from '../../src/kernel/state/ops.shared.ts';
/** Flags every command takes; each command declares the rest (as cac parses them: camelCase, `--no-open` -> open: false). */
export interface Global {
  repo?: string;
}
/** For commands: an error the entry point prints (exit 1, or 2 for usage); throwing keeps commands testable. */
export function fail(message: string, status?: number): never {
  throw new ReviewroomError(message, status);
}

/** Errors go to stdout like every result (AXI): the agent reads one stream. */
export function die(msg: string, code = 1): never {
  console.log('error: ' + msg);
  process.exit(code);
}

/** The next commands an agent can run, after a result. Falsy lines are skipped. */
export function hint(...lines: unknown[]) {
  const shown = lines.filter((l): l is string => typeof l === 'string' && !!l);
  if (shown.length) console.log(`help:\n${shown.map((l) => `  ${l}`).join('\n')}`);
}

/** How an agent should run `wait`: a backgrounded `&` job dies when a Codex or pi shell call returns (review-rounds.md). */
export const WAIT_HOW = 'as a background task if your shell tells you when it exits, else in the foreground with --timeout 25, again until a round prints; never with &';
