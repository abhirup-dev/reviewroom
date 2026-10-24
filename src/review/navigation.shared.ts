import type { Anchor } from '../kernel/state/schema.shared';

export type CodeTarget = { path: string; side: 'base' | 'head'; start?: number; end?: number; rev?: string; view?: 'diff' | 'file'; panel?: string };
export type Selection =
  | { kind: 'code'; path: string; side: 'base' | 'head'; start: number; end: number; x: number; y: number }
  | { kind: 'doc'; anchor: Extract<Anchor, { kind: 'doc' }>; x: number; y: number; label: string }
  | null;

