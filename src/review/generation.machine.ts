// Generation in the page: the one owner of the loading screen, the header indicator, Generate and the report's
// placeholder. Pure, no DOM: fed the reduced progress (progress.shared.ts) from /api/progress and the `progress` event,
// it decides what the page shows; generation.ts draws it.
//
//   stage (from the documents' states)                                   overlay (the loading screen; orthogonal)
//   idle ─generate─▶ starting ─written─▶ writing ─walkthrough validated─▶ playable ─report validated─▶ done
//                       │                   │                               │        shown ─dismiss─▶ dismissed
//                       └───────────────────┴───────── a stop ──────────────┴─▶ stopped     ◀─reopen, or a new request─
//                                       stopped ─generate (Retry)─▶ starting
//
//   progress { progress }   the reduced documents' states (and `generation` where the assistant runs); the first one
//                           places the machine
//   generate                Generate / Retry: starting at once, until the request answers
//   generated { progress }  the request was taken; failed { error }: refused, with a readable message
//   dismiss / reopen        close the loading screen to the bare review / open it again (the header indicator)
//
// It emits `play` when the walkthrough becomes playable while the reviewer waited for it: the player opens at slide 1.
import { assign, enqueueActions, raise, setup, type SnapshotFrom } from 'xstate';
import { pendingArtifact, type Progress } from '../kernel/state/progress.shared';

export type Stage = 'idle' | 'starting' | 'writing' | 'playable' | 'done' | 'stopped';
export const STAGES: readonly Stage[] = ['idle', 'starting', 'writing', 'playable', 'done', 'stopped'];
export type GenerationContext = {
  progress: Progress;
  /** the server can generate here (`generate` in /api/meta) */
  canGenerate: boolean;
  /** a Generate request is on its way: starting until it answers */
  requesting: boolean;
  /** why the last Generate was refused, readable */
  error: string | null;
  /** the reviewer saw this generation under way (starting or writing): a playable walkthrough then opens */
  waited: boolean;
};
export type GenerationEvent =
  | { type: 'progress'; progress: Progress }
  | { type: 'generate' }
  | { type: 'generated'; progress: Progress }
  | { type: 'failed'; error: string }
  | { type: 'dismiss' }
  | { type: 'reopen' };

/** The stage the documents are in. A stop wins over everything but both documents validated. */
export function stageOf({ progress: { walkthrough: w, report: r }, requesting }: Pick<GenerationContext, 'progress' | 'requesting'>): Stage {
  if (w.state === 'validated' && r.state === 'validated') return 'done';
  if (requesting && !pendingArtifact(w) && !pendingArtifact(r)) return 'starting';
  if (w.state === 'stopped' || r.state === 'stopped') return 'stopped';
  if (pendingArtifact(w)) return w.state === 'requested' ? 'starting' : 'writing';
  if (pendingArtifact(r)) return w.state === 'validated' ? 'playable' : r.state === 'requested' ? 'starting' : 'writing';
  return w.state === 'idle' && r.state === 'idle' ? 'idle' : 'done';
}

type Ctx = { context: GenerationContext; event: GenerationEvent };
/** The context an event leaves (guards run before its actions assign it). */
const after = ({ context, event }: Ctx) => ({
  progress: event.type === 'progress' || event.type === 'generated' ? event.progress : context.progress,
  requesting: event.type === 'generated' || event.type === 'failed' ? false : context.requesting,
});
/** Each stage, routed from where the event leaves the documents: stageOf names exactly one. */
const route = (actions: ('take' | 'answer')[]) => STAGES.map((s) => ({ guard: (x: Ctx) => stageOf(after(x)) === s, target: `.${s}`, actions }));

export const generationMachine = setup({
  types: { context: {} as GenerationContext, events: {} as GenerationEvent, input: {} as { canGenerate: boolean }, emitted: {} as { type: 'play' } },
  guards: {
    canGenerate: ({ context }) => context.canGenerate && !context.requesting && ['idle', 'stopped'].includes(stageOf(context)),
  },
  actions: {
    take: assign(({ event }) => (event.type === 'progress' || event.type === 'generated' ? { progress: event.progress } : {})),
    request: assign({ requesting: true, error: null }),
    answer: assign(({ event }) => ({ requesting: false, error: event.type === 'failed' ? event.error : null })),
  },
}).createMachine({
  id: 'generation',
  type: 'parallel',
  context: ({ input }) => ({ progress: { walkthrough: { state: 'idle' }, report: { state: 'idle' } }, canGenerate: input.canGenerate, requesting: false, error: null, waited: false }),
  states: {
    // the routing lives in this region: a transition from the root would re-enter the overlay too
    stage: {
      initial: 'idle',
      on: {
        progress: route(['take']),
        generate: { guard: 'canGenerate', target: '.starting', actions: 'request' },
        generated: route(['take', 'answer']),
        failed: route(['answer']),
      },
      states: {
        idle: { entry: assign({ waited: false }) },
        // a new request (Generate, Retry, or an agent's) brings the loading screen back
        starting: { entry: [assign({ waited: true }), raise({ type: 'reopen' })] },
        writing: { entry: assign({ waited: true }) },
        playable: { entry: enqueueActions(({ context, enqueue }) => {
          if (context.waited) enqueue.emit({ type: 'play' });
          enqueue.assign({ waited: false });
        }) },
        done: { entry: assign({ waited: false }) },
        stopped: { entry: assign({ waited: false }) },
      },
    },
    overlay: {
      initial: 'shown',
      states: {
        shown: { on: { dismiss: 'dismissed' } },
        dismissed: { on: { reopen: 'shown' } },
      },
    },
  },
});

export type GenerationSnapshot = SnapshotFrom<typeof generationMachine>;
export const stageIn = (s: GenerationSnapshot) => STAGES.find((st) => s.matches({ stage: st }))!;
/** The loading screen: open, while there is something to wait for or a stop to read. */
export const screenShown = (s: GenerationSnapshot) => s.matches({ overlay: 'shown' }) && ['starting', 'writing', 'stopped'].includes(stageIn(s));
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
