import { markdownWorkerSource } from '../../scripts/markdown-worker' with { type: 'macro' };
import type { DocumentDiff, InlineDiff, Request } from './model';

const source = markdownWorkerSource();
let worker: Worker | undefined;
let next = 0;
const pending = new Map<number, { resolve: (v: DocumentDiff | InlineDiff[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function compute(request: Request): Promise<DocumentDiff | InlineDiff[]> {
  if (!worker) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    worker.onmessage = (e: MessageEvent<{ id: number; result: DocumentDiff | InlineDiff[]; error?: string }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      clearTimeout(job.timer);
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.result);
    };
    worker.onerror = () => reset();
  }
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(reset, 5000);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, request }, []);
  });
}

function reset() {
  worker?.terminate();
  worker = undefined;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(new Error('Markdown rendering timed out or is unavailable. Open Source to inspect the diff.'));
  }
  pending.clear();
}
