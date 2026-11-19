// Generation in the page: the one owner of the loading screen, the header indicator, Generate and the report's
// placeholder. Pure, no DOM: fed the reduced progress (progress.shared.ts) from /api/progress and the `progress` event,
// it decides what the page shows; generation.ts draws it. The progress (the server's, over SSE) is the truth: where
// generation stands is its stageOf, except while Generate's request is on its way (starting).
//
//   request  idle ─generate─▶ requesting (the POST) ─▶ idle once the progress shows another request pair than it was
//            pressed over, or the POST says there is nothing to write, or refuses. Leaving stops the POST, so its late
//            answer is dropped and a stop of the new request wins at any time. The POST's progress is never taken (it
//            can be older than what SSE already delivered).
//   screen   open ─dismiss─▶ closed on the request pair shown ─reopen, or any new pair─▶ open. Closed while Generate's
//            request is on its way, it stays closed for the request that answers.
//
// It emits `play` once per walkthrough request: when the walkthrough validates for a request this page saw pending (or
// asked for), whatever else the same snapshot carries; and `refused` with Generate's refusal, readable.
import { assign, emit, enqueueActions, fromPromise, setup, stateIn, type SnapshotFrom } from 'xstate';
import { pendingArtifact, stageOf, type Progress, type Stage } from '../kernel/state/progress.shared';

/** The request pair a progress shows: what the screen's closing and Generate's bridge are keyed on. */
export const requestKey = ({ walkthrough: w, report: r }: Progress) => `${w.request ?? ''}|${r.request ?? ''}`;

/** What a tab keeps over a reload (the server reloads the page when a document stops or lands). */
export type Remembered = { closedFor?: string | null; waitedFor?: string | null; played?: string | null };
export type GenerationContext = {
  progress: Progress;
  /** the server can generate here (`generate` in /api/meta) */
  canGenerate: boolean;
  /** the request pair Generate was pressed over */
  askedOver: string;
  /** why the last Generate was refused, readable */
  error: string | null;
  /** the request pair the loading screen was closed on */
  closedFor: string | null;
  /** the walkthrough request this page saw pending (or asked for): validated, it plays */
  waitedFor: string | null;
  /** the walkthrough request already played */
  played: string | null;
};
export type GenerationEvent = { type: 'progress'; progress: Progress } | { type: 'generate' } | { type: 'dismiss' } | { type: 'reopen' };
const progressOf = (e: GenerationEvent) => (e as Extract<GenerationEvent, { type: 'progress' }>).progress;
const keyOf = ({ event }: { event: GenerationEvent }) => requestKey(progressOf(event));
const reason = (error: unknown) => (error as Error).message;

export const generationMachine = setup({
  types: {
    context: {} as GenerationContext, events: {} as GenerationEvent, input: {} as { canGenerate: boolean } & Remembered,
    emitted: {} as { type: 'play'; request: string } | { type: 'refused'; error: string },
  },
  actors: {
    /** POST api/generate: true once taken, false with nothing to write; throws its refusal, readable. The page provides it. */
    generate: fromPromise<boolean>(async () => false),
  },
  guards: {
    // apart from the stage shown: any document not validated and none on its way (a PR's walkthrough with no report
    // yet shows done, and Generate writes the report: api/generate asks only for what isn't validated)
    canGenerate: ({ context: { canGenerate, progress: { walkthrough: w, report: r } } }) =>
      canGenerate && !pendingArtifact(w) && !pendingArtifact(r) && !(w.state === 'validated' && r.state === 'validated'),
  },
  actions: {
    take: enqueueActions(({ context: c, event, enqueue }) => {
      const progress = progressOf(event), w = progress.walkthrough;
      const waitedFor = pendingArtifact(w) && w.request ? w.request : c.waitedFor;
      const play = w.state === 'validated' && !!w.request && w.request === waitedFor && c.played !== w.request;
      enqueue.assign({ progress, waitedFor, ...(play && { played: w.request }) });
      if (play) enqueue.emit({ type: 'play', request: w.request! });
    }),
  },
}).createMachine({
  id: 'generation',
  type: 'parallel',
  context: ({ input }) => ({
    progress: { walkthrough: { state: 'idle' }, report: { state: 'idle' } }, canGenerate: input.canGenerate, askedOver: '', error: null,
    closedFor: input.closedFor ?? null, waitedFor: input.waitedFor ?? null, played: input.played ?? null,
  }),
  states: {
    request: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            progress: { actions: 'take' },
            generate: { guard: 'canGenerate', target: 'requesting', actions: assign({ askedOver: ({ context }) => requestKey(context.progress), error: null }) },
          },
        },
        requesting: {
          invoke: {
            src: 'generate',
            onDone: { guard: ({ event }) => !event.output, target: 'idle' },
            onError: { target: 'idle', actions: [assign({ error: ({ event }) => reason(event.error) }), emit(({ event }) => ({ type: 'refused' as const, error: reason(event.error) }))] },
          },
          on: {
            progress: [
              // the new request shows: from here the progress says what happens to it. A new walkthrough request, asked
              // for here, plays however fast it lands (a report-only retry keeps the old one)
              {
                guard: ({ context, event }) => keyOf({ event }) !== context.askedOver,
                target: 'idle',
                actions: [assign({ waitedFor: ({ context: c, event }) => { const w = progressOf(event).walkthrough; return w.request && w.request !== c.askedOver.split('|')[0] ? w.request : c.waitedFor; } }), 'take'],
              },
              { actions: 'take' },
            ],
          },
        },
      },
    },
    screen: {
      initial: 'boot',
      states: {
        // closed by this tab before a reload: closed until a new request pair
        boot: { always: [{ guard: ({ context }) => context.closedFor !== null, target: 'closed' }, { target: 'open' }] },
        open: { entry: assign({ closedFor: null }), on: { dismiss: { target: 'closed', actions: assign({ closedFor: ({ context }) => requestKey(context.progress) }) } } },
        closed: {
          on: {
            progress: [
              { guard: stateIn({ request: 'requesting' }), actions: assign({ closedFor: keyOf }) }, // follows Generate's request until it answers
              { guard: ({ context, event }) => keyOf({ event }) !== context.closedFor, target: 'open' },
            ],
            reopen: 'open',
          },
        },
      },
    },
  },
});

export type GenerationSnapshot = SnapshotFrom<typeof generationMachine>;
/** Where generation stands: the documents' stage, or starting while Generate's request is on its way. */
export const stageIn = (s: GenerationSnapshot): Stage => {
  const stage = stageOf(s.context.progress);
  return stage !== 'done' && s.matches({ request: 'requesting' }) ? 'starting' : stage;
};
/** What the tab keeps over a reload. */
export const remembered = ({ context: c }: GenerationSnapshot): Remembered => ({ closedFor: c.closedFor, waitedFor: c.waitedFor, played: c.played });
/** The loading screen: open while there is something to wait for or a stop to read, unless closed for this request. */
export const screenShown = (s: GenerationSnapshot) => ['starting', 'writing', 'stopped'].includes(stageIn(s)) && s.matches({ screen: 'open' });
/** The header indicator: generation under way (or stopped) with the loading screen closed. Gone at idle and done. */
export const indicatorShown = (s: GenerationSnapshot) => !['idle', 'done'].includes(stageIn(s)) && !screenShown(s);
/** Generate (or Retry) is offered: a document not validated, where the server can generate, and no request on its way. */
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
    case 'stopped':
    case 'report-stopped': {
      const stopped = w.state === 'stopped' ? w : r;
      const which = w.state === 'stopped' ? 'walkthrough' : 'report';
      return stopped.reason === 'interrupted' ? `Stopped: the review restarted while the ${which} was being written` : `Stopped: the ${which} was not finished`;
    }
    case 'done': return 'Walkthrough and report ready';
    default: return 'Nothing generated yet';
  }
}
