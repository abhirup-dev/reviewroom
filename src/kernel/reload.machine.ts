// A reload the page wants, for one reason or several (a new build, a screen that suits another form), held while
// reloading would lose work (pwa.ts busy()). Pure, no DOM: the host samples the hold each tick and provides the
// actions (offer, withdraw, reload).
//
//   idle ─want─▶ pending ─tick, nothing held───────▶ reloading (final: runs `reload`)
//                  │  ▲   ─go (the reader takes it)─▶ reloading
//                  │  └ want / drop / tick held: stays; `offer` on each held tick (the host keeps one toast current)
//                  └─last reason dropped─▶ idle (`withdraw` the offer)
//
//   want { key, nuke? }   add or refresh a reason; nuke: drop the worker and its caches before reloading
//   drop { key }          that reason no longer applies (the screen suits the page again)
//   tick { held }         the host's sample of pwa.ts shouldHoldReload(busy())
//   go                    reload now, held or not
import { assign, setup } from 'xstate';

export type ReloadEvent = { type: 'want'; key: string; nuke?: boolean } | { type: 'drop'; key: string } | { type: 'tick'; held: boolean } | { type: 'go' };
export type Reasons = Record<string, { nuke: boolean }>;

export const reloadMachine = setup({
  types: { context: {} as { reasons: Reasons }, events: {} as ReloadEvent },
  actions: {
    add: assign(({ context, event }) => (event.type === 'want' ? { reasons: { ...context.reasons, [event.key]: { nuke: !!event.nuke || (Object.hasOwn(context.reasons, event.key) && context.reasons[event.key].nuke) } } } : {})),
    remove: assign(({ context, event }) => (event.type === 'drop' ? { reasons: Object.fromEntries(Object.entries(context.reasons).filter(([k]) => k !== event.key)) } : {})),
    offer: () => {},
    withdraw: () => {},
    reload: () => {},
  },
  guards: {
    none: ({ context }) => Object.keys(context.reasons).length === 0,
    free: ({ event }) => event.type === 'tick' && !event.held,
  },
}).createMachine({
  id: 'reload',
  context: { reasons: {} },
  initial: 'idle',
  states: {
    idle: { on: { want: { target: 'pending', actions: 'add' } } },
    pending: {
      always: { guard: 'none', target: 'idle', actions: 'withdraw' },
      on: {
        want: { actions: 'add' },
        drop: { actions: 'remove' },
        tick: [{ guard: 'free', target: 'reloading' }, { actions: 'offer' }],
        go: 'reloading',
      },
    },
    reloading: { type: 'final', entry: 'reload' },
  },
});
