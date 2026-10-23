import type { Thread } from '../kernel/state/model.shared';

export const isTestFile = (p: string) => /(^|\/)(__tests__|tests?|spec)(\/)|[._-](test|spec)\.[a-z]+$|_test\.go$/.test(p);
export const fileType = (p: string) => (p.includes('.') ? p.split('.').pop()!.toLowerCase() : 'other');
/** Reading order: the change itself first, then its tests; alphabetical within each. */
export const reviewOrder = (a: { path: string }, b: { path: string }) => Number(isTestFile(a.path)) - Number(isTestFile(b.path)) || a.path.localeCompare(b.path);


/** A thread on lines of a file. */
export type CodeThread = Thread & { anchor: Extract<Thread['anchor'], { kind: 'code' }> };
/** The threads on lines of one file (open or resolved). */
export const codeThreadsOn = (threads: Thread[], path: string) => threads.filter((t): t is CodeThread => t.anchor.kind === 'code' && t.anchor.path === path);
