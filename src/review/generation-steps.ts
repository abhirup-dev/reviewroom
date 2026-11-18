// The loading screen's steps, from the progress alone. Pure: generation.ts draws them on the screen and on the phone.
// A step never moves backwards: each new save of the walkthrough is one more pass under "Checking the slides".
import type { ArtifactProgress, Progress } from '../kernel/state/progress.shared';

export type StepState = 'done' | 'current' | 'upcoming' | 'stopped';
export type StepId = 'read-write' | 'check' | 'ready' | 'report';
export type PassRow = { text: string; state: Exclude<StepState, 'upcoming'> };
export type GenStep = { id: StepId; title: string; detail: string; state: StepState; passes?: PassRow[] };

const counts = (p: { slides?: number; chapters?: number }) => (p.slides === undefined ? '' : `${p.slides} slides in ${p.chapters ?? 0} chapters`);
const stopText = (p: ArtifactProgress) => (p.reason === 'interrupted' ? 'Stopped: the review restarted' : 'Stopped before it passed the check');

export function generationSteps({ walkthrough: w, report: r }: Progress): GenStep[] {
  const passes = w.passes ?? [];
  const stopped = w.state === 'stopped';
  // how far the walkthrough is: 0 reading and writing (until its first save), 1 checking, 3 past ready (a walkthrough
  // validated, or kept from the PR)
  const at = w.state === 'validated' ? 3 : passes.length ? 1 : 0;
  const state = (i: number): StepState => (i < at ? 'done' : i > at ? 'upcoming' : stopped ? 'stopped' : 'current');
  const rows = passes.map((p, i): PassRow => {
    const last = i === passes.length - 1;
    const [label, s]: [string, PassRow['state']] = !last ? ['revised', 'done'] : at === 3 ? ['passed', 'done'] : stopped ? ['did not pass', 'stopped'] : ['checking', 'current'];
    return { text: [`Pass ${i + 1}`, counts(p), label].filter(Boolean).join(' · '), state: s };
  });
  const first = state(0) === 'stopped' ? stopText(w) : passes[0] ? `First draft · ${counts(passes[0])}` : 'The first draft';
  const report: StepState = at < 3 ? 'upcoming' : r.state === 'validated' ? 'done' : r.state === 'stopped' ? 'stopped' : r.state === 'idle' ? 'upcoming' : 'current';
  return [
    { id: 'read-write', title: 'Reading the change and writing the walkthrough', detail: first, state: state(0) },
    { id: 'check', title: 'Checking the slides', detail: state(1) === 'stopped' ? stopText(w) : passes.length > 1 ? `${passes.length} passes` : 'Every save is checked', state: state(1), ...(rows.length && { passes: rows }) },
    { id: 'ready', title: 'Walkthrough ready', detail: at === 3 ? counts(w) || 'Ready' : 'The player opens here', state: state(2) },
    { id: 'report', title: 'Writing the report', detail: report === 'stopped' ? stopText(r) : report === 'done' ? 'Ready' : report === 'current' ? 'Being written' : 'Continues in the review', state: report },
  ];
}
