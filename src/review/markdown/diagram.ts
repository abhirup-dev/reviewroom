import { mountAsync } from 'pele/lazy';
import DOMPurify from 'dompurify';

/** Diagram types load on first use; source cannot enable remote images or active links. */
export function mountDiagram(element: HTMLElement, source: string) {
  return mountAsync(element, source, {
    limit: 20_000,
    maxEdges: 300,
    outputLimit: 500_000,
    images: false,
    links: false,
    fontSize: 14,
    sanitize: (svg) => DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true }),
  });
}
