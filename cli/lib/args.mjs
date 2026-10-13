// Shared parse result: the entry point (cac) fills these once per process; commands mutate them
// (e.g. pr hands --dir to serve), so share the objects. Keys are the flags as typed: `no-open`, `dir`.
export const flags = {};
export const pos = [];
export const die = (msg, code = 1) => {
  console.error('reviewroom: ' + msg);
  process.exit(code);
};
