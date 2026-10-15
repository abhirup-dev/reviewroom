// Shared parse result: the entry point (cac) fills these once per process; commands mutate them
// (e.g. pr hands --dir to serve), so share the objects. Keys are the flags as typed: `no-open`, `dir`.
export const flags: Record<string, any> = {};
export const pos: string[] = [];
export const die = (msg: string, code = 1): never => {
  console.error('reviewroom: ' + msg);
  process.exit(code);
};
