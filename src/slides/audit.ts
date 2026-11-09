// Measuring the step on screen, for `reviewroom slide-lint` (which judges the numbers: cli/lib/slide-lint.ts).
// The code views draw only the rows near their viewport, so a highlight's size comes from its line count too.
import type { PaneShown } from './player.machine';
import type { ChunkAudit, StepAudit } from './model.shared';
import { refreshDiagrams } from '../review/elements';

/** Elements matching `sel` under `root`, inside shadow roots too (the diff views render in one). */
function deepAll(root: Element | ShadowRoot, sel: string, out: Element[] = []): Element[] {
  out.push(...root.querySelectorAll(sel));
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
  return out;
}

/** The highlighted code rows' span in a code view's scroller: [top, bottom] in viewport px, or null (none drawn).
 *  Comment cards on the lines are marked selected too, but carry no line type. */
function highlight(scroller: Element): [number, number] | null {
  const rows = deepAll(scroller, '[data-selected-line][data-line-type]').map((e) => e.getBoundingClientRect());
  return rows.length ? [Math.min(...rows.map((r) => r.top)), Math.max(...rows.map((r) => r.bottom))] : null;
}

/** Widgets signal actual asynchronous work, instead of guessing readiness from unchanged empty boxes. */
function proseReady(left: HTMLElement, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ready: boolean) => { observer.disconnect(); clearTimeout(timer); resolve(ready); };
    const check = () => { if (!left.querySelector('[aria-busy="true"]')) done(true); };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => done(false), Math.max(0, deadline - performance.now()));
    observer.observe(left, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
    check();
  });
}

async function fontsReady(deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([document.fonts.ready.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), Math.max(0, deadline - performance.now())); })]).finally(() => clearTimeout(timer));
}

/** Wait for actual resources, then refresh Pele at the visible width directly. Geometry reads synchronously
 *  update browser layout: no display-frame quiet period is needed. The code pane has its own landed signal.
 *  False: resources or layout have not settled within 4 s. */
export async function settle(left: HTMLElement): Promise<boolean> {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    if (!await proseReady(left, deadline)) return false;
    void left.offsetHeight; // layout discovers fonts introduced by newly arrived prose, including code previews
    if (!await fontsReady(deadline)) return false;
    refreshDiagrams(left);
    if (!left.querySelector('[aria-busy="true"]') && document.fonts.status !== 'loading') return true;
  }
  return false;
}

function chunk(el: Element | undefined, pane: HTMLElement, ref: string, lines: number): ChunkAudit {
  const scroller = el?.querySelector('.rr-code-scroll');
  if (!scroller) return { ref, code: false, lines: 0, visible: 0, hidden: 0 };
  // stacked chunks can run past the pane (it scrolls): what shows is the part inside both
  const [s, p] = [scroller.getBoundingClientRect(), pane.getBoundingClientRect()];
  const box = { top: Math.max(s.top, p.top), bottom: Math.max(Math.max(s.top, p.top), Math.min(s.bottom, p.bottom)) };
  const lineH = deepAll(scroller, '[data-line]')[0]?.getBoundingClientRect().height || 20;
  const span = highlight(scroller);
  // rows past the drawn ones are not in the DOM: the highlight is at least its line count tall
  const hidden = !lines ? 0 : !span ? lines : Math.ceil((Math.max(0, box.top - span[0]) + Math.max(0, Math.max(span[1], span[0] + lines * lineH) - box.bottom)) / lineH);
  return { ref, code: true, lines, visible: Math.floor((box.bottom - box.top) / lineH), hidden: Math.min(lines, hidden) };
}

/** Measure the step on screen. `shown`: what the pane shows (paneMachine's context). */
export function measure(els: { left: HTMLElement; lead: HTMLElement; pane: HTMLElement }, shown: PaneShown | null, stripped: StepAudit['stripped'], settled: boolean): StepAudit {
  const { left, lead, pane } = els;
  const slots = shown?.kind === 'refs' ? shown.slots : [];
  const wider = (e: Element) => e.scrollWidth > e.clientWidth + 1;
  const wide = [
    ...(wider(left) ? ['narration'] : []),
    ...[...left.querySelectorAll('pre, table, svg, img')].filter(wider).map((e) => e.tagName.toLowerCase()),
  ];
  return {
    left: { visible: left.clientHeight, content: left.scrollHeight, lead: lead.hidden ? 0 : lead.offsetHeight },
    chunks: slots.map((s, i) => chunk(pane.children[i], pane, s.ref, s.code?.start ? (s.code.end ?? s.code.start) - s.code.start + 1 : 0)),
    wide: [...new Set(wide)],
    stripped,
    settled,
  };
}
