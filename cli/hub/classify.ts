// What kind of review a session is, from its launch metadata only, and which page of it to open.
import type { SessionCategory, SessionKind, ToolName } from '../../src/hub/model.shared.ts';

export interface ClassificationInput {
  tool: ToolName;
  mode: string | null;
  label: string | null;
  args?: string[];
  command?: string | null;
  /** reviewroom: PR number and head ref from its session record. */
  pr?: number | string | null;
  head?: string | null;
}

export interface SessionClassification {
  category: SessionCategory;
  kind: SessionKind;
  target: string | null;
  source: string;
}

const URL_RE = /^https?:\/\//i;
const HTML_RE = /\.html?$/i;

const clean = (v: string | null | undefined) => v?.trim() || null;

function targetFromCommand(command: string | null, verb: string): string | null {
  if (!command) return null;
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clean(command.match(new RegExp(`(?:^|\\s)${escaped}\\s+(?:--[^\\s]+\\s+)*([^\\s]+)`, 'i'))?.[1]);
}

export function classifySession(input: ClassificationInput): SessionClassification {
  const mode = (input.mode ?? '').toLowerCase();
  const label = clean(input.label);
  const args = input.args ?? [];
  const command = input.command ?? null;
  const is = (category: SessionCategory, kind: SessionKind, target: string | null, source: string) => ({ category, kind, target, source });

  if (input.tool === 'reviewroom') {
    const source = 'reviewroom session record';
    if (input.pr) return is('review', 'pull-request-review', `#${input.pr}`, source);
    return is('review', 'code-review', input.head === 'worktree' ? 'uncommitted changes' : clean(input.head), source);
  }

  if (input.tool === 'crit') {
    const source = 'crit registry args';
    const verb = (args[0] ?? mode).toLowerCase();
    const after = (flag: string) => clean(args[args.indexOf(flag) + 1]);
    if (verb === 'live') return is('live-artifact', 'live-web-review', clean(args[1]), source);
    if (verb === 'preview') return is('live-artifact', 'html-preview', clean(args[1]), source);
    if (verb === 'plan') return is('review', 'plan-review', clean(args.at(-1)), source);
    if (verb === 'story') return is('review', 'story-review', null, source);
    if (args.includes('--pr')) return is('review', 'pull-request-review', after('--pr'), source);
    if (args.includes('--mr')) return is('review', 'merge-request-review', after('--mr'), source);
    if (args.includes('--range')) return is('review', 'commit-range-review', after('--range'), source);
    if (args.length === 0 || verb === 'review') return is('review', 'code-review', null, source);
    const target = clean(args.find((a) => !a.startsWith('-')) ?? label);
    if (target && HTML_RE.test(target)) return is('live-artifact', 'html-preview', target, source);
    if (target && URL_RE.test(target)) return is('live-artifact', 'live-web-review', target, source);
    return is('annotate', 'artifact-annotation', target, source);
  }

  // plannotator: the registry mode and label, refined by the launch command once known
  const source = command ? 'process command' : 'plannotator registry';
  const cmd = command ?? '';
  if (/\bsetup-goal\b/i.test(cmd) || mode === 'goal-setup') return is('review', 'goal-setup', label, source);
  if (/\b(?:annotate-last|last|copilot-last)\b/i.test(cmd) || mode.includes('last') || /(?:^|-)last(?:-|$)/i.test(label ?? '')) return is('annotate', 'last-message-annotation', null, source);
  if (/\barchive\b/i.test(cmd) || mode === 'archive') return is('browse', 'archive-browser', null, source);
  if (/\bguide\b/i.test(cmd) || mode.includes('guide')) return is('review', 'guided-review', label, source);
  if (mode.includes('plan')) return is('review', 'plan-review', label, 'plannotator registry');
  if (/\breview\b/i.test(cmd) || mode === 'review') {
    const change = command?.match(/https?:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+/i)?.[0] ?? null;
    const isMr = !!change?.includes('/merge_requests/') || /^mr-review-/i.test(label ?? '');
    const isPr = !!change?.includes('/pull/') || /^pr-review-/i.test(label ?? '');
    return is('review', isMr ? 'merge-request-review' : isPr ? 'pull-request-review' : 'code-review', change, source);
  }
  const target = targetFromCommand(command, 'annotate') ?? label;
  const localUrl = !!target && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(target);
  if (/\s--app(?:\s|$)/.test(cmd) || localUrl || mode.includes('app') || mode.includes('live')) return is('live-artifact', 'live-web-review', target, source);
  if (target && HTML_RE.test(target)) return is('live-artifact', 'html-preview', target, source);
  if (target && URL_RE.test(target)) return is('annotate', 'web-page-annotation', target, source);
  if (target && /[\\/]$/.test(target)) return is('annotate', 'folder-annotation', target, source);
  if (mode === 'annotate' || /\bannotate\b/i.test(cmd)) return is('annotate', 'artifact-annotation', target, source);
  return is('other', 'unknown', target, 'insufficient metadata');
}

/** Crit serves every surface from one daemon and its launcher opens rendered HTML at /preview and proxied apps at
 *  /live (crit v0.19.0, cmd/crit/cli_serve.go). Plannotator records the complete URL; it is used unchanged. */
export function surfacePath(tool: ToolName, kind: SessionKind): string {
  if (tool !== 'crit') return '';
  return kind === 'html-preview' ? '/preview' : kind === 'live-web-review' ? '/live' : '';
}

export function sessionOpenUrl(tool: ToolName, baseUrl: string | null, kind: SessionKind): string | null {
  const suffix = surfacePath(tool, kind);
  return baseUrl && suffix ? baseUrl.replace(/\/$/, '') + suffix : baseUrl;
}
