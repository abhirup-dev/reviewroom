// Cross-runtime Web APIs available in both Bun and browsers. Deliberately excludes DOM and Node APIs.
declare function structuredClone<T>(value: T): T;
declare class URLSearchParams {
  constructor(init: string);
  get(name: string): string | null;
}
