import { ReviewroomError } from '../../src/shared/ops.ts';
/** Flags every command takes; each command declares the rest (as cac parses them: camelCase, `--no-open` -> open: false). */
export interface Global {
  repo?: string;
  dir?: string;
}
/** For commands: an error the entry point prints (exit 1); throwing keeps commands testable. */
export function fail(message: string, status?: number): never {
  throw new ReviewroomError(message, status);
}

export function die(msg: string, code = 1): never {
  console.error('reviewroom: ' + msg);
  process.exit(code);
}
