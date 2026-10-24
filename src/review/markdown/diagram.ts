import { mountAsync } from 'pele/lazy';
import DOMPurify from 'dompurify';

/** The rendered SVG, with only http(s) and rr: links left in it (geometry and CSS values are not URLs). */
export const sanitizeDiagram = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|rr):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    RETURN_DOM_FRAGMENT: true,
  });

/** Diagram types load on first use; source cannot enable remote images; `click` statements may link to rr: and http(s). */
export function mountDiagram(element: HTMLElement, source: string) {
  return mountAsync(element, source, {
    limit: 20_000,
    maxEdges: 300,
    outputLimit: 500_000,
    images: false,
    linkSchemes: ['http', 'https', 'rr'],
    fontSize: 14,
    sanitize: sanitizeDiagram,
  });
}
