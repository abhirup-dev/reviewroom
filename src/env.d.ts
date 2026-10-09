declare module 'virtual:rr-css' {
  const css: string;
  export default css;
}
declare module '*/feedback.mjs' {
  export function feedbackMarkdown(state: import('./core/types').ReviewState, opts: { kind: 'feedback' | 'approve'; note?: string; codeExcerpt?: (a: any) => string | null }): string;
}
declare module '*/ops.mjs' {
  export function applyOp(state: import('./core/types').ReviewState, op: import('./core/types').Op): import('./core/types').ReviewState;
}
