import { expect, test } from 'bun:test';
import { moduleImports } from './features-imports';

test('ownership sees type-only imports and re-exports before erasure', () => {
  expect(moduleImports('guard.ts', `
    import type { A } from './a';
    import { type B } from './b';
    export { type C } from './c';
    export type * from './d';
    type E = import('./e').E;
  `)).toEqual(['a', 'b', 'c', 'd', 'e'].map(name => ({ path: './' + name, typeOnly: true })));
});

test('side effects, mixed specifiers, dynamic imports and exports are runtime edges', () => {
  expect(moduleImports('guard.ts', `
    import './a';
    import { type B, value } from './b';
    export { type C, value } from './c';
    export * from './d';
    void import('./e');
    import F = require('./f');
    // import './not-an-edge';
    const text = "import './not-an-edge'";
  `)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({ path: './' + name, typeOnly: false })));
});
