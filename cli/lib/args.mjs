// Parsed once per process; commands mutate `flags`/`pos` (e.g. pr hands --dir to serve), so share the objects.
const argv = process.argv.slice(2);
export const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'help';
export const flags = {};
export const pos = [];
const BOOL = new Set(['detach', 'wait', 'no-open', 'force', 'all', 'json', 'resolve']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (eq >= 0) flags[k] = a.slice(eq + 1);
    else if (!BOOL.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
export const die = (msg, code = 1) => {
  console.error('reviewroom: ' + msg);
  process.exit(code);
};
