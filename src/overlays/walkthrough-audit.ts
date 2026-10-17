// Measuring the step on screen, for `reviewroom walkthrough lint` (which judges the numbers: cli/lib/tour-lint.ts).
// The code views draw only the rows near their viewport, so a highlight's size comes from its line count too.
import type { PaneShown } from '../flows/walkthrough';
import type { ChunkAudit, StepAudit } from '../shared/walkthrough';

const frame = () => new Promise((r) => requestAnimationFrame(r));

/** Elements matching `sel` under `root`, inside shadow roots too (the diff views render in one). */
function deepAll(root: Element | ShadowRoot, sel: string, out: Element[] = []): Element[] {
  out.push(...root.querySelectorAll(sel));
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
  return out;
}

/** The highlighted rows' span in a code view's scroller: [top, bottom] in viewport px, or null (none drawn). */
function highlight(scroller: Element): [number, number] | null {
  const rows = deepAll(scroller, '[data-selected-line]').map((e) => e.getBoundingClientRect());
  return rows.length ? [Math.min(...rows.map((r) => r.top)), Math.max(...rows.map((r) => r.bottom))] : null;
}

/** Wait until the highlight of every chunk with lines (`highlighted`, per chunk) is drawn and stops moving: it
 *  lands after an unfold and a scroll. False: still moving after ~3 s. */
export async function settle(pane: HTMLElement, highlighted: boolean[]): Promise<boolean> {
  await document.fonts.ready;
  let last = '';
  for (let i = 0; i < 90; i++) {
    await frame();
    await frame();
    const spans = [...pane.children].map((c) => c.querySelector('.rr-code-scroll')).map((s) => s && highlight(s));
    const now = JSON.stringify(spans);
    const drawn = spans.every((s, j) => !highlighted[j] || s);
    if (drawn && now === last) return true;
    last = now;
  }
  return false;
}

function chunk(el: Element | undefined, ref: string, lines: number): ChunkAudit {
  const scroller = el?.querySelector('.rr-code-scroll');
  if (!scroller) return { ref, code: false, lines: 0, visible: 0, hidden: 0 };
  const box = scroller.getBoundingClientRect();
  const lineH = deepAll(scroller, '[data-line]')[0]?.getBoundingClientRect().height || 20;
  const span = highlight(scroller);
  // rows past the drawn ones are not in the DOM: the highlight is at least its line count tall
  const hidden = !lines ? 0 : !span ? lines : Math.ceil((Math.max(0, box.top - span[0]) + Math.max(0, Math.max(span[1], span[0] + lines * lineH) - box.bottom)) / lineH);
  return { ref, code: true, lines, visible: Math.floor(scroller.clientHeight / lineH), hidden: Math.min(lines, hidden) };
}

/** Measure the step on screen. `shown`: what the pane shows (paneMachine's context). */
export function measure(els: { left: HTMLElement; lead: HTMLElement; pane: HTMLElement }, shown: PaneShown | null, stripped: string[], settled: boolean): StepAudit {
  const { left, lead, pane } = els;
  const kind = shown?.kind ?? 'empty';
  const slots = shown?.kind === 'refs' ? shown.slots : [];
  const wider = (e: Element) => e.scrollWidth > e.clientWidth + 1;
  const wide = [
    ...(wider(left) ? ['narration'] : []),
    ...[...left.querySelectorAll('pre, table, rr-flow, svg, img')].filter(wider).map((e) => e.tagName.toLowerCase()),
    ...[...pane.querySelectorAll('.rr-tour__diagram')].filter(wider).map(() => 'diagram'),
  ];
  return {
    left: { visible: left.clientHeight, content: left.scrollHeight, lead: lead.hidden ? 0 : lead.offsetHeight },
    pane: kind,
    chunks: slots.map((s, i) => chunk(pane.children[i], s.ref, s.code?.start ? (s.code.end ?? s.code.start) - s.code.start + 1 : 0)),
    wide: [...new Set(wide)],
    stripped,
    settled,
  };
}
