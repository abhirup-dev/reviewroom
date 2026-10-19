/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated workers use messages without target origins. */
import { documentDiff, inlineDiff, type Request } from './model';

self.onmessage = (event: MessageEvent<{ id: number; request: Request }>) => {
  const { id, request } = event.data;
  try {
    let budget = 80_000;
    const result = request.kind === 'document' ? documentDiff(request.before, request.after) : request.pairs.map((p) => {
      budget -= p.before.length + p.after.length;
      return budget >= 0 ? inlineDiff(p.before, p.after) : { before: [], after: [] };
    });
    self.postMessage({ id, result });
  } catch {
    self.postMessage({ id, error: 'Markdown could not be rendered. Open Source to inspect the diff.' });
  }
};
