// `bun run setup-phone`, apart from `bun run setup`: puts the hub on this Mac's tailnet (tailscale serve, HTTPS on
// :4847) and on portless (https://reviewroom.localhost:1355), saves the tailnet address as the hub's public origin and
// restarts the hub. A phone then installs the app from that fixed address (README: Use reviewroom from a phone).
// Safe to run again. `--dry-run` prints the commands instead.
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PORT = 4847; // the hub's port; the tailnet address keeps it, so it never changes
const dry = process.argv.includes('--dry-run');
const out = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });
const fail = (m: string): never => (console.error(`reviewroom: ${m}`), process.exit(1));
const run = (cmd: string, args: string[]) => {
  console.error(`$ ${[cmd, ...args].join(' ')}`);
  if (dry) return;
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// Tailscale installed, logged in, with HTTPS certificates (else `serve --https` waits on a prompt)
const st = out('tailscale', ['status', '--json']);
if (st.error) fail('no tailscale CLI: install Tailscale (https://tailscale.com/download) and log in');
const status = JSON.parse(st.stdout || '{}');
const host: string | undefined = status.Self?.DNSName?.replace(/\.$/, '');
if (!host || status.BackendState !== 'Running') fail('Tailscale is not running or not logged in (`tailscale up`)');
if (!status.CertDomains?.length) fail('HTTPS is off on your tailnet: enable HTTPS certificates at https://login.tailscale.com/admin/dns');

const origin = `https://${host}:${PORT}`;
const target = `http://127.0.0.1:${PORT}`;
const web = JSON.parse(out('tailscale', ['serve', 'status', '--json']).stdout || '{}').Web ?? {};
const mapped: string | undefined = web[`${host}:${PORT}`]?.Handlers?.['/']?.Proxy;
if (mapped && mapped !== target) fail(`tailscale serve already sends ${origin} to ${mapped}; free it (\`tailscale serve --https=${PORT} off\`) and run this again`);
if (!mapped) run('tailscale', ['serve', '--bg', `--https=${PORT}`, target]); // --bg: tailscaled keeps it across restarts

// the name on this Mac; the hub admits it (cli/hub/access.ts, LOCAL_ORIGIN)
if (out('portless', ['list']).error) console.error('reviewroom: no portless, skipping https://reviewroom.localhost:1355');
else run('portless', ['alias', 'reviewroom', String(PORT)]);

const cli = path.join(import.meta.dir, '..', 'dist/cli/reviewroom.js');
run('bun', [cli, 'hub', '--public-origin', origin, '--stop']); // saves the origin; a running hub must restart to use it
run('bun', [cli, 'hub', '--detach', '--no-open']);
console.error(`reviewroom: on your phone (on the tailnet), open ${origin}/ and install it from More > Install app`);
