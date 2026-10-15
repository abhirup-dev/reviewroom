/** A command's flags, keyed as typed (`dir`, `no-open`); built per command by run() in cli/reviewroom.ts. */
export type Opts = Partial<
  Record<'repo' | 'dir' | 'base' | 'head' | 'title' | 'remote' | 'port' | 'file', string> &
    // a switch is true, or a string when repeated (`--force --force` → "true,true"); --json [file] takes a value
    Record<'force' | 'detach' | 'wait' | 'no-open' | 'forever' | 'threads' | 'all' | 'resolve' | 'fix' | 'accept' | 'json', string | true>
>;
export function die(msg: string, code = 1): never {
  console.error('reviewroom: ' + msg);
  process.exit(code);
}
