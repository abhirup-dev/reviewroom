declare module 'virtual:rr-css' {
  const css: string;
  export default css;
}
declare module '*/feedback.mjs' {
  export function feedbackMarkdown(state: import('./core/types').ReviewState, opts: { kind: 'feedback' | 'approve'; note?: string; codeExcerpt?: (a: any) => string | null }): string;
}
