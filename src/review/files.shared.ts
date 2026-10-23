export const isTestFile = (p: string) => /(^|\/)(__tests__|tests?|spec)(\/)|[._-](test|spec)\.[a-z]+$|_test\.go$/.test(p);
export const fileType = (p: string) => (p.includes('.') ? p.split('.').pop()!.toLowerCase() : 'other');
/** Reading order: the change itself first, then its tests; alphabetical within each. */
export const reviewOrder = (a: { path: string }, b: { path: string }) => Number(isTestFile(a.path)) - Number(isTestFile(b.path)) || a.path.localeCompare(b.path);

