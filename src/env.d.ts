declare module '*/bundle.css' {
  const css: string;
  export default css;
}
declare module '*.svg' {
  const svg: string;
  export default svg;
}
/** The build id, baked in by scripts/build.ts. */
declare const __RR_BUILD__: string;
