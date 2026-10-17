// Where reviewroom's own files live: the package (templates, built client) and the per-user home.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = path.join(PKG, 'dist');
const homeDir = () => process.env.REVIEWROOM_HOME || path.join(os.homedir(), '.reviewroom');
export const registryDir = () => path.join(homeDir(), 'sessions');
/** Every review on this machine: reviews/<owner>-<repo>/<branch>/ (resolveDir). */
export const reviewsDir = () => path.join(homeDir(), 'reviews');
/** The reviewer's named layout files (`default.json` is their default), shared by every review on this machine. */
export const layoutsDir = () => path.join(homeDir(), 'layouts');
