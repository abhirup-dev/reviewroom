// The loading screen's steps, from the progress alone (and, with the built-in assistant, whether its stream shows the
// first write of the walkthrough yet). Pure: generation.ts draws them on the screen, in the header's popover and on the
// phone. A step never moves backwards: each new save of the walkthrough is one more pass under "Checking the slides".
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';

export type StepState = 'done' | 'current' | 'upcoming' | 'stopped';
export type StepId = 'read' | 'write' | 'read-write' | 'check' | 'ready' | 'report';
export type PassRow = { text: string; state: Exclude<StepState, 'upcoming'> };
export type GenStep = { id: StepId; title: string; detail: string; state: StepState; passes?: PassRow[] };

const counts = (p: { slides?: number; chapters?: number }) => (p.slides === undefined ? '' : `${p.slides} slides in ${p.chapters ?? 0} chapters`);
const stopText = (p: ArtifactProgress) => (p.reason === 'interrupted' ? 'Stopped: the review restarted' : 'Stopped before it passed the check');

/** `stream`: the assistant's stream is shown (it alone tells reading from writing: else they are one step);
 *  `wrote`: that stream shows its first write to the walkthrough. */
export function generationSteps({ walkthrough: w, report: r }: Progress, { stream, wrote }: { stream: boolean; wrote: boolean }): GenStep[] {
  const passes = w.passes ?? [];
  const stopped = w.state === 'stopped';
  // how far the walkthrough is: 0 reading, 1 writing, 2 checking, 4 past ready (a walkthrough validated, or kept from the PR)
  const at = w.state === 'validated' ? 4 : passes.length ? 2 : wrote && stream ? 1 : 0;
  const state = (i: number): StepState => (i < at ? 'done' : i > at ? 'upcoming' : stopped ? 'stopped' : 'current');
  const first = passes[0] ? `First draft · ${counts(passes[0])}` : 'The first draft';
  const rows = passes.map((p, i): PassRow => {
    const last = i === passes.length - 1;
    const [label, s]: [string, PassRow['state']] = !last ? ['revised', 'done'] : at === 4 ? ['passed', 'done'] : stopped ? ['did not pass', 'stopped'] : ['checking', 'current'];
    return { text: [`Pass ${i + 1}`, counts(p), label].filter(Boolean).join(' · '), state: s };
  });
  const reading: GenStep[] = stream
    ? [
        { id: 'read', title: 'Reading the change', detail: 'The diff and the files it touches', state: state(0) },
        { id: 'write', title: 'Writing the walkthrough', detail: first, state: state(1) },
      ]
    : [{ id: 'read-write', title: 'Reading the change and writing the walkthrough', detail: first, state: at > 1 ? 'done' : stopped ? 'stopped' : 'current' }];
  if (stopped && at <= 1) reading[stream ? at : 0].detail = stopText(w);
  const report: StepState = at < 4 ? 'upcoming' : r.state === 'validated' ? 'done' : r.state === 'stopped' ? 'stopped' : r.state === 'idle' ? 'upcoming' : 'current';
  return [
    ...reading,
    { id: 'check', title: 'Checking the slides', detail: state(2) === 'stopped' ? stopText(w) : passes.length > 1 ? `${passes.length} passes` : 'Every save is checked', state: state(2), ...(rows.length && { passes: rows }) },
    { id: 'ready', title: 'Walkthrough ready', detail: at === 4 ? counts(w) || 'Ready' : 'The player opens here', state: state(3) },
    { id: 'report', title: 'Writing the report', detail: report === 'stopped' ? stopText(r) : report === 'done' ? 'Ready' : report === 'current' ? 'Being written' : 'Continues in the review', state: report },
  ];
}
