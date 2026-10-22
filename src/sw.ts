// Service worker, compiled to dist/sw.js by scripts/build.ts with the build id and precache list baked in.
// A stub for now: the caching logic is rr-o9x.4.
declare const self: ServiceWorkerGlobalScope; // narrows the global: this file is a module (it exports)
declare const __RR_BUILD__: string;
declare const __RR_PRECACHE__: string[];

export const CACHE = `rr-${__RR_BUILD__}`;
self.addEventListener('install', () => console.debug(CACHE, __RR_PRECACHE__));
