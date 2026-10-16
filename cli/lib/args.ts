/** Flags every command takes; each command declares the rest (as cac parses them: camelCase, `--no-open` → open: false). */
export interface Global {
  repo?: string;
  dir?: string;
}
export function die(msg: string, code = 1): never {
  console.error('reviewroom: ' + msg);
  process.exit(code);
}
