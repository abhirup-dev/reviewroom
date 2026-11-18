// The pages' event streams (/api/events). Each stream gets every change of progress once: its snapshot and the
// broadcasts go through one path that remembers, per stream, the last progress queued to it. A global "last sent"
// would skip a change for a stream that connected in between (its snapshot was newer than the broadcast it matched).
type Writer = { writeSSE(m: { event: string; data: string }): Promise<void> };

export class Streams<S extends Writer> {
  private last = new Map<S, string>();
  get size() {
    return this.last.size;
  }
  /** Registers `stream` and queues its snapshot. The snapshot is computed first: one that throws registers nothing. */
  add(stream: S, snapshot: () => [event: string, data: unknown][]) {
    const events = snapshot().map(([event, data]) => [event, JSON.stringify(data)] as const);
    this.last.set(stream, '');
    for (const [event, text] of events) this.deliver(stream, event, text);
  }
  delete(stream: S) {
    this.last.delete(stream);
  }
  send(event: string, data: unknown) {
    const text = JSON.stringify(data);
    for (const stream of this.last.keys()) this.deliver(stream, event, text);
  }
  private deliver(stream: S, event: string, text: string) {
    // a turn's end and the file watcher may both report the same state: a stream gets it once
    if (event === 'progress') {
      if (this.last.get(stream) === text) return;
      this.last.set(stream, text);
    }
    stream.writeSSE({ event, data: text }).catch(() => {});
  }
}
