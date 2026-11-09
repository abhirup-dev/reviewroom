// Select audits by stable ids without slicing the document the player uses to resolve inherited targets.
import { target, type Walkthrough } from '../../src/slides/model.shared.ts';
import { parseRef } from '../../src/kernel/refs/refs.shared.ts';
import { fail } from './args.ts';
import { extractLinks, uncomment } from './links.ts';

export type SlideSelector = { chapter?: string; slide?: string };
type Scope = { kind: 'all' } | { kind: 'chapter'; chapter: string } | { kind: 'slide'; chapter: string; step: string };
export type SlideSelection = { scope: Scope; slides: { chapter: string; step: string }[]; total: number };

export function selectSlides(w: Walkthrough, o: SlideSelector): SlideSelection {
  if (o.chapter !== undefined && o.slide !== undefined) fail('--chapter and --slide are mutually exclusive');
  const slides = w.chapters.flatMap((c) => c.steps.map((s) => ({ chapter: c.id, step: s.id })));
  const total = slides.length;
  if (o.chapter !== undefined) {
    if (typeof o.chapter !== 'string' || !w.chapters.some((c) => c.id === o.chapter)) fail(`unknown chapter ${JSON.stringify(o.chapter)}; chapters: ${w.chapters.map((c) => c.id).join(', ')}`);
    return { scope: { kind: 'chapter', chapter: o.chapter }, slides: slides.filter((s) => s.chapter === o.chapter), total };
  }
  if (o.slide !== undefined) {
    const ref = typeof o.slide === 'string' ? parseRef(o.slide) : null;
    const id = ref?.type === 'tour' ? `${ref.chapter}/${ref.step}` : o.slide;
    const at = slides.find((s) => `${s.chapter}/${s.step}` === id);
    if (!at) fail(`unknown slide ${JSON.stringify(o.slide)}; slides: ${slides.map((s) => `${s.chapter}/${s.step}`).join(', ')}`);
    return { scope: { kind: 'slide', ...at }, slides: [at], total };
  }
  return { scope: { kind: 'all' }, slides, total };
}

/** Only selected prose, its chapter leads and its effective pane refs. Locations name the selected consumers. */
export function selectionLinks(w: Walkthrough, selection: SlideSelection): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (refs: string[], where: string) => {
    for (const ref of refs) {
      const places = found.get(ref) ?? [];
      if (!places.includes(where)) places.push(where);
      found.set(ref, places);
    }
  };
  for (const at of selection.slides) {
    const chapter = w.chapters.findIndex((c) => c.id === at.chapter);
    const ch = w.chapters[chapter], step = ch.steps.findIndex((s) => s.id === at.step);
    add(extractLinks(uncomment(ch.lead ?? '')), ch.id);
    const pane = target({ doc: w, chapter, step });
    add([...extractLinks(uncomment(ch.steps[step].text)), ...(pane.kind === 'refs' ? pane.refs : [])], `${ch.id}/${at.step}`);
  }
  return found;
}
