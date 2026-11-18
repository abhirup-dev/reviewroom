// Generation in the page: the one owner of the loading screen, the header indicator, Generate and the report's
// placeholder. Pure, no DOM: fed the reduced progress (progress.shared.ts) from /api/progress and the `progress` event,
// it decides what the page shows; generation.ts draws it.
//
//   idle ─generate─▶ starting ─written─▶ writing ─walkthrough validated─▶ playable ─report validated─▶ done
//                       │                   │                               │
//                       └───────────────────┴───────── a stop ──────────────┴─▶ stopped ─generate (Retry)─▶ starting
//
// The progress (the server's, over SSE) is the truth. Generate only bridges the moment until the new request shows in
// it: `requesting` holds the request ids it was pressed over, and the first progress with other ids ends it, so a stop
// of the new request wins at any time. The POST's answer settles only "taken" (or "nothing to do") or "refused"; its
// progress snapshot is never taken (it can be older than what SSE already delivered).
//
// The loading screen is closed per request: `closedFor` is the pair of request ids (walkthrough|report) it was closed
// on, so a repeat of the same progress keeps it closed and any new request opens it, whatever stage it is first seen
// at. Closed while Generate's request is on its way, it stays closed for the request that answers.
//
// It emits `play` once per walkthrough request: when the walkthrough validates for a request this page saw pending,
// whatever else the same snapshot carries (the report validated with it).
//
//   progress { progress }    the reduced documents' states (and `generation` where the assistant runs)
//   generate                 Generate / Retry: starting at once, until the new request shows
//   generated { started }    the request was taken (started: false: nothing to write); failed { error }: refused
//   dismiss / reopen         close the loading screen to the bare review / open it again (the header indicator)
import { enqueueActions, setup, type SnapshotFrom } from 'xstate';
import { pendingArtifact, type Progress } from '../kernel/state/progress.shared';

export type Stage = 'idle' | 'starting' | 'writing' | 'playable' | 'done' | 'stopped';
export const STAGES: readonly Stage[] = ['idle', 'starting', 'writing', 'playable', 'done', 'stopped'];
/** Closed before Generate's request showed: it becomes that request's key when it does. */
const PENDING = 'pending';
/** The request pair a progress shows: what the screen's closing and Generate's bridge are keyed on. */
export const requestKey = ({ walkthrough: w, report: r }: Progress) => `${w.request ?? ''}|${r.request ?? ''}`;

/** What a tab keeps over a reload (the server reloads the page when a document stops or lands). */
export type Remembered = { closedFor?: string | null; waitedFor?: string | null; played?: string | null };
export type GenerationContext = {
  progress: Progress;
  /** the server can generate here (`generate` in /api/meta) */
  canGenerate: boolean;
  /** Generate pressed over these request ids; null once the progress shows a newer request, or it is refused */
  requesting: string | null;
  /** why the last Generate was refused, readable */
  error: string | null;
  /** the request pair the loading screen was closed on */
  closedFor: string | null;
  /** the walkthrough request this page saw pending (or asked for): validated, it plays */
  waitedFor: string | null;
  /** the walkthrough request already played */
  played: string | null;
};
export type GenerationEvent =
  | { type: 'progress'; progress: Progress }
  | { type: 'generate' }
  | { type: 'generated'; started: boolean }
  | { type: 'failed'; error: string }
  | { type: 'dismiss' }
  | { type: 'reopen' };

/** The stage the documents are in. A stop wins over everything but both documents validated. */
export function stageOf({ progress, requesting }: Pick<GenerationContext, 'progress' | 'requesting'>): Stage {
  const { walkthrough: w, report: r } = progress;
  if (w.state === 'validated' && r.state === 'validated') return 'done';
  if (requesting !== null) return 'starting';
  if (w.state === 'stopped' || r.state === 'stopped') return 'stopped';
  if (pendingArtifact(w)) return w.state === 'requested' ? 'starting' : 'writing';
  if (pendingArtifact(r)) return w.state === 'validated' ? 'playable' : r.state === 'requested' ? 'starting' : 'writing';
  return w.state === 'idle' && r.state === 'idle' ? 'idle' : 'done';
}

/** The context an event leaves. Pure: the guards route on it and the update action assigns it. */
export function next(c: GenerationContext, e: GenerationEvent): GenerationContext {
  let { progress, requesting, error, closedFor, waitedFor, played } = c;
  switch (e.type) {
    case 'progress': progress = e.progress; break;
    case 'generate': requesting = requestKey(progress); error = null; break;
    case 'generated': if (!e.started) requesting = null; break; // taken: the progress ends the bridge
    case 'failed': requesting = null; error = e.error; break;
    case 'dismiss': closedFor = requesting !== null ? PENDING : requestKey(progress); break;
    case 'reopen': closedFor = null; break;
  }
  const w = progress.walkthrough;
  if (requesting !== null && requestKey(progress) !== requesting) {
    const [askedOver] = requesting.split('|');
    requesting = null; // the new request shows: from here the progress says what happens to it
    // a new walkthrough request, asked for here: it plays, however fast it lands (a report-only retry keeps the old one)
    if (w.request && w.request !== askedOver) waitedFor = w.request;
  }
  if (requesting === null && closedFor === PENDING) closedFor = requestKey(progress); // closed on the request that answered
  if (pendingArtifact(w) && w.request) waitedFor = w.request;
  if (w.state === 'validated' && w.request && w.request === waitedFor && played !== w.request) played = w.request;
  return { ...c, progress, requesting, error, closedFor, waitedFor, played };
}

type Ctx = { context: GenerationContext; event: GenerationEvent };
/** Each stage, routed from the context the event leaves: stageOf names exactly one. */
const route = STAGES.map((s) => ({ guard: (x: Ctx) => stageOf(next(x.context, x.event)) === s, target: `.${s}`, actions: 'update' as const }));

export const generationMachine = setup({
  types: { context: {} as GenerationContext, events: {} as GenerationEvent, input: {} as { canGenerate: boolean } & Remembered, emitted: {} as { type: 'play'; request: string } },
  guards: {
    canGenerate: ({ context }) => context.canGenerate && context.requesting === null && ['idle', 'stopped'].includes(stageOf(context)),
  },
  actions: {
    update: enqueueActions(({ context, event, enqueue }) => {
      const after = next(context, event);
      enqueue.assign(after);
      if (after.played !== context.played && after.played) enqueue.emit({ type: 'play', request: after.played });
    }),
  },
}).createMachine({
  id: 'generation',
  type: 'parallel',
  context: ({ input }) => ({
    progress: { walkthrough: { state: 'idle' }, report: { state: 'idle' } }, canGenerate: input.canGenerate, requesting: null, error: null,
    closedFor: input.closedFor ?? null, waitedFor: input.waitedFor ?? null, played: input.played ?? null,
  }),
  states: {
    // one region, so snapshots read `{ stage: … }`
    stage: {
      initial: 'idle',
      on: {
        progress: route,
        generate: { guard: 'canGenerate', target: '.starting', actions: 'update' },
        generated: route,
        failed: route,
        dismiss: { actions: 'update' },
        reopen: { actions: 'update' },
      },
      states: { idle: {}, starting: {}, writing: {}, playable: {}, done: {}, stopped: {} },
    },
  },
});

export type GenerationSnapshot = SnapshotFrom<typeof generationMachine>;
export const stageIn = (s: GenerationSnapshot) => STAGES.find((st) => s.matches({ stage: st }))!;
/** What the tab keeps over a reload. */
export const remembered = ({ context: c }: GenerationSnapshot): Remembered => ({ closedFor: c.closedFor === PENDING ? null : c.closedFor, waitedFor: c.waitedFor, played: c.played });
const closed = ({ context: c }: GenerationSnapshot) => c.closedFor === PENDING || (c.closedFor !== null && c.closedFor === requestKey(c.progress));
/** The loading screen: open, while there is something to wait for or a stop to read, unless closed for this request. */
export const screenShown = (s: GenerationSnapshot) => ['starting', 'writing', 'stopped'].includes(stageIn(s)) && !closed(s);
/** The header indicator: generation under way (or stopped) with the loading screen closed. Gone at idle and done. */
export const indicatorShown = (s: GenerationSnapshot) => ['starting', 'writing', 'playable', 'stopped'].includes(stageIn(s)) && !screenShown(s);
/** Generate (or Retry) is offered: idle or stopped, where the server can generate, and no request on its way. */
export const generateOffered = (s: GenerationSnapshot) => s.can({ type: 'generate' });
/** The turn waits for the reviewer's approval in the assistant panel (rare: assistant turns approve their tools). */
export const awaitingApproval = (s: GenerationSnapshot) => !!s.context.progress.generation?.awaitingApproval && ['starting', 'writing', 'playable'].includes(stageIn(s));
/** The report is still being written (its panel says so). */
export const reportWaiting = (s: GenerationSnapshot) => ['starting', 'writing', 'playable'].includes(stageIn(s)) && pendingArtifact(s.context.progress.report);

/** One line on where generation stands, for the screen and the indicator. */
export function statusText(s: GenerationSnapshot): string {
  const { walkthrough: w, report: r } = s.context.progress;
  switch (stageIn(s)) {
    case 'starting': return 'Reading the diff';
    case 'writing': return w.state === 'writing' ? `${w.slides ?? 0} slides in ${w.chapters ?? 0} chapters written, checking` : 'Writing the walkthrough';
    case 'playable': return 'Writing the report';
    case 'stopped': {
      const stopped = w.state === 'stopped' ? w : r;
      const which = w.state === 'stopped' ? 'walkthrough' : 'report';
      return stopped.reason === 'interrupted' ? `Stopped: the review restarted while the ${which} was being written` : `Stopped: the ${which} was not finished`;
    }
    case 'done': return 'Walkthrough and report ready';
    default: return 'Nothing generated yet';
  }
}
