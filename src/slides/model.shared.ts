// The walkthrough.json contract: a guided walkthrough of the diff, played over the workbench. Defined once
// here; the server, `reviewroom check`, `pr`, `publish-slides` and the client all validate with it, and
// schema/walkthrough.schema.json is generated from it. No DOM or Node imports.
import { z } from 'zod';
import { parseRef, type Ref } from '../kernel/refs/refs.shared';
import { issueList } from '../kernel/state/schema.shared';

const nonEmpty = z.string().min(1, 'must be a non-empty string');
// quoted into the agent's feedback markdown: a line break there could forge a heading
const title = nonEmpty.max(120, 'must be at most 120 characters').regex(/^[^\r\n]*$/, 'must be one line');
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits and dashes');
const html = z.string().describe('Prose HTML: rr: links, <rr-mermaid>, <rr-flow>, <rr-code> work as in review.html');
// a ref the right pane can show: code/file with ordered, positive lines; sym/doc with a name
const showable = (input: string) => {
  const r = parseRef(input);
  if (r?.type === 'code' || r?.type === 'file') return !!r.path && (r.start === undefined || (r.start >= 1 && r.end! >= r.start));
  return (r?.type === 'sym' && !!r.name) || (r?.type === 'doc' && !!r.id);
};

const unique = (ids: string[], what: string, ctx: z.RefinementCtx, at: (i: number) => (string | number)[]) =>
  ids.forEach((v, i) => {
    if (ids.indexOf(v) !== i) ctx.addIssue({ code: 'custom', path: at(i), message: `duplicate ${what} id "${v}"` });
  });

const paneRefMessage = 'must be an rr:code/, rr:file/, rr:sym/ or rr:doc/ link (lines #L<start>-<end>, start >= 1, end >= start)';
const PaneRef = z.string().regex(/^rr:(code|file|sym|doc)\//, paneRefMessage).refine(showable, { message: paneRefMessage, when: (p) => !p.issues.length });

export const Step = z.object({
  id,
  text: html.min(1, 'must be a non-empty string'),
  ref: z
    .union([PaneRef, z.array(PaneRef).min(1, 'needs at least one link')])
    .optional()
    .describe('What the right pane shows for this step: one link (its whole file, the lines highlighted), or several (each chunk stacked, across files). Omitted: keep the previous target (the pane shows only code)'),
  focus: z
    .array(nonEmpty)
    .optional()
    .describe('Labels of the diagram nodes (<rr-node>, or a Mermaid node in an <rr-mermaid>) that light up on this step, in the lead or the text. Omitted: nodes whose ref overlaps the code the pane shows; [] lights none'),
});

/** A step's pane links as a list (`ref` may be one link or several). */
export const stepRefs = (s: Pick<Step, 'ref'>): string[] => (s.ref === undefined ? [] : [s.ref].flat());

// the same code: one file at one revision, lines overlapping (a link without lines covers the file)
const overlaps = (a: Ref | null, b: Ref | null): boolean => {
  if ((a?.type === 'code' || a?.type === 'file') && (b?.type === 'code' || b?.type === 'file'))
    return a.path === b.path && a.rev === b.rev && (!a.start || !b.start || (a.start <= b.end! && b.start <= a.end!));
  if (a?.type === 'sym' && b?.type === 'sym') return a.name === b.name;
  return a?.type === 'doc' && b?.type === 'doc' && a.id === b.id;
};

/** A diagram node's label as `focus` compares it: whitespace runs collapsed (the player reads it from the page, slide-lint from Pele's SVG). */
export const nodeLabel = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Whether a diagram node (an <rr-node>, or a Mermaid node) lights up on a step: one its `focus` names, else one whose ref overlaps the pane's links. */
export const inFocus = (node: { label: string; ref: string | null }, focus: string[] | undefined, paneRefs: string[]): boolean =>
  focus ? focus.some((f) => nodeLabel(f) === nodeLabel(node.label)) : !!node.ref && paneRefs.some((r) => overlaps(parseRef(node.ref!), parseRef(r)));

/** Whether a Mermaid edge runs between two lit nodes. Pele ids flowchart edges `L_<from>_<to>_<n>` and class-diagram
 *  edges `id_<from>_<to>_<n>`; other types' edge ids don't name their nodes, so their edges never light.
 *  shortcut: node ids with `_` can make two lit pairs read alike (an extra edge flows); upgrade if Pele exposes edge endpoints. */
export const edgeBetween = (edgeId: string, lit: string[]): boolean =>
  lit.some((a) => lit.some((b) => edgeId.startsWith(`L_${a}_${b}_`) || edgeId.startsWith(`id_${a}_${b}_`)));

const Chapter = z
  .object({
    id,
    title,
    lead: html.optional().describe('Static for the whole chapter; may hold an <rr-mermaid> or <rr-flow> diagram'),
    steps: z.array(Step).min(1, 'needs at least one step'),
  })
  .superRefine((c, ctx) => unique(c.steps.map((s) => s.id), 'step', ctx, (i) => ['steps', i, 'id']));

export const Walkthrough = z
  .object({
    version: z.literal(1),
    title,
    chapters: z.array(Chapter).min(1, 'needs at least one chapter'),
  })
  .superRefine((w, ctx) => unique(w.chapters.map((c) => c.id), 'chapter', ctx, (i) => ['chapters', i, 'id']));

export type Step = z.infer<typeof Step>;
export type Walkthrough = z.infer<typeof Walkthrough>;

/** A position in a loaded or loading guided walkthrough. Helpers require a loaded document. */
export type WalkthroughPosition = { doc: Walkthrough | null; chapter: number; step: number };
/** What the pane is asked to show, before any browser-side code lookup. */
export type PaneWant = { kind: 'refs'; refs: string[] } | { kind: 'empty' };

/** Where the player is, for views. */
export function current({ doc, chapter, step }: WalkthroughPosition) {
  const ch = doc!.chapters[chapter];
  const last = doc!.chapters.length - 1;
  return { chapter: ch, step: ch.steps[step], isFirst: chapter === 0 && step === 0, isLast: chapter === last && step === ch.steps.length - 1 };
}

/** What the code pane shows for the current step: its links; else the chapter's last links so far; else the chapter
 *  last links of an earlier chapter; else nothing. The lead's diagram stays in the lead. */
export function target({ doc, chapter, step }: WalkthroughPosition): PaneWant {
  const ch = doc!.chapters[chapter];
  const last = (steps: Walkthrough['chapters'][number]['steps']) => stepRefs(steps.findLast((s) => s.ref) ?? {});
  const back = last(ch.steps.slice(0, step + 1));
  if (back.length) return { kind: 'refs', refs: back };
  const earlier = last(doc!.chapters.slice(0, chapter).flatMap((c) => c.steps));
  return earlier.length ? { kind: 'refs', refs: earlier } : { kind: 'empty' };
}

/** The `?walkthrough=<chapter>/<step>` deep link (either part optional); null when absent. */
export function deepLink(search: string): { chapter?: string; step?: string } | null {
  const v = new URLSearchParams(search).get('walkthrough');
  if (v === null) return null;
  const [chapter, step] = v.split('/');
  return { chapter: chapter || undefined, step: step || undefined };
}

export type Parsed = { ok: true; value: Walkthrough } | { ok: false; issues: string[] };

/** Parses walkthrough.json text; each issue is `path: message`. */
export function parseWalkthrough(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [`not JSON: ${(e as Error).message}`] };
  }
  const r = Walkthrough.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: issueList(r.error) };
}

/** Validated feature data from either server JSON or the static page's embedded JSON text. */
export type LoadedWalkthrough = Walkthrough | { issues: string[] } | null;
export function decodeWalkthrough(input: unknown): LoadedWalkthrough {
  if (input === null || input === undefined) return null;
  // A server's 422 response already contains human-readable validation issues.
  if (typeof input === 'object' && 'issues' in input && Array.isArray(input.issues) && input.issues.every((issue) => typeof issue === 'string'))
    return { issues: input.issues };
  if (typeof input === 'string') {
    const parsed = parseWalkthrough(input);
    return parsed.ok ? parsed.value : { issues: parsed.issues };
  }
  const parsed = Walkthrough.safeParse(input);
  return parsed.success ? parsed.data : { issues: issueList(parsed.error) };
}

/** schema/walkthrough.schema.json, generated by scripts/schema.ts. */
export const walkthroughJsonSchema = () => ({
  ...z.toJSONSchema(Walkthrough, { target: 'draft-2020-12', io: 'input' }),
  $id: 'reviewroom/walkthrough.schema.json',
  title: 'reviewroom guided walkthrough (walkthrough.json in the review dir)',
});

// ------------------------------------------------------------------ measuring a step (`slide-lint`)
// The page measures (src/slides/audit.ts), the CLI judges (cli/lib/slide-lint.ts). Sizes in CSS px.

/** One chunk of the code pane: `lines` highlighted, of which `hidden` are off screen when it lands; `visible`: lines
 *  the chunk shows at once. No code (a preview card: a section, an unknown symbol): `code: false`. */
export type ChunkAudit = { ref: string; code: boolean; lines: number; visible: number; hidden: number };
export type StepAudit = {
  /** the narration's visible and full height, and the chapter lead's height */
  left: { visible: number; content: number; lead: number };
  chunks: ChunkAudit[];
  /** content wider than its box (sideways scrolling): 'narration' or a tag inside the narration */
  wide: string[];
  /** what the sanitizer took out of the chapter lead and the step's text */
  stripped: { lead: string[]; text: string[] };
  /** false: the code had not settled when the page gave up waiting (the numbers may be off) */
  settled: boolean;
};

// ------------------------------------------------------------------ the PR block
// A walkthrough travels in a PR comment or description as a fenced ```reviewroom-walkthrough block
// (`reviewroom publish-slides` writes it, `reviewroom pr` reads it). The HTML comment marks the comment we own.
export const BLOCK_MARK = '<!-- reviewroom-walkthrough -->';
const LANG = 'reviewroom-walkthrough';

/** The markdown for a PR comment carrying `doc`; the fence outgrows any backtick run inside. */
export function encodeBlock(doc: Walkthrough) {
  const json = JSON.stringify(doc, null, 2);
  const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${BLOCK_MARK}\n${fence}${LANG}\n${json}\n${fence}\n`;
}

/** The contents of every top-level ```reviewroom-walkthrough block in `md`, in order (not ones nested in other fences). */
export function findBlocks(md: string): string[] {
  const out: string[] = [];
  let open: { fence: string; body: string[] | null } | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open) {
      // CommonMark: a backtick fence's info string has no backticks (else it is not a fence)
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) open = { fence: m[1], body: m[2].trim().split(/\s+/)[0] === LANG ? [] : null };
    } else if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length && !line.slice(line.indexOf(m[1]) + m[1].length).trim()) {
      if (open.body) out.push(open.body.join('\n'));
      open = null;
    } else open.body?.push(line);
  }
  if (open?.body) out.push(open.body.join('\n')); // an unclosed fence runs to the end
  return out;
}
