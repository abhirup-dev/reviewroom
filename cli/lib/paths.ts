// Where reviewroom's own files live: the package (templates, built client) and the per-user home.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = path.join(PKG, 'dist');
const homeDir = () => process.env.REVIEWROOM_HOME || path.join(os.homedir(), '.reviewroom');
export const registryDir = () => path.join(homeDir(), 'sessions');
/** The hub's record (`reviewroom hub`, one per machine) and its log when started in the background. */
export const hubFile = () => path.join(homeDir(), 'hub.json');
export const hubLog = () => path.join(homeDir(), 'hub.log');
/** The reviewer's own default panel layout (dockview JSON), shared by every review on this machine. */
export const layoutFile = () => path.join(homeDir(), 'layout.json');
