// Where reviewroom's own files live: the package (templates, built client) and the per-user home.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = path.join(PKG, 'dist');
/** ~/.reviewroom, or REVIEWROOM_HOME. Clones the hub makes live in its repos/<owner>/<repo>. */
export const homeDir = () => process.env.REVIEWROOM_HOME || path.join(os.homedir(), '.reviewroom');
export const registryDir = () => path.join(homeDir(), 'sessions');
/** The hub's record (`reviewroom hub`, one per machine) and its log when started in the background. */
export const hubFile = () => path.join(homeDir(), 'hub.json');
export const hubLog = () => path.join(homeDir(), 'hub.log');
/** The reviewer's settings for this machine: publicOrigin (ADR 0001), assistant defaults and reviewAgentPromptFile. */
export const settingsFile = () => path.join(homeDir(), 'config.json');
/** Every review on this machine: reviews/<owner>-<repo>/<branch>/ (resolveDir). */
export const reviewsDir = () => path.join(homeDir(), 'reviews');
/** HOME for harness bootstrap/state, separate from the native agent's real HOME and login. */
export const assistantHome = () => path.resolve(homeDir(), 'assistant');
/** The reviewer's saved layouts (<name>.json), shared by every review on this machine. */
export const layoutsDir = () => path.join(homeDir(), 'layouts');
/** Which saved layout is the reviewer's default: { "layout": "<name>" }. */
export const defaultLayoutFile = () => path.join(homeDir(), 'default-layout.json');
