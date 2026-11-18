// One stream of text, told to every reader: whoever follows gets everything said so far, then the rest as it is said.
// A reader that leaves only stops reading; closing ends every reader and keeps nothing.

export type ReplayStream = ReturnType<typeof replayStream>;

/** `headers`: what each follower's response carries (its content type, say). */
export function replayStream(headers: Record<string, string>) {
  const said: string[] = [];
  const readers = new Set<ReadableStreamDefaultController<string>>();
  let closed = false;
  return {
    say(text: string) {
      if (closed) return;
      said.push(text);
      for (const r of readers) try { r.enqueue(text); } catch { readers.delete(r); }
    },
    /** A reader: replayed and joined in one synchronous step, so nothing falls between the two or arrives twice. */
    follow() {
      let reader!: ReadableStreamDefaultController<string>;
      const body = new ReadableStream<string>({
        start(ctrl) {
          reader = ctrl;
          for (const text of said) ctrl.enqueue(text);
          if (closed) ctrl.close();
          else readers.add(ctrl);
        },
        cancel: () => void readers.delete(reader),
      });
      return new Response(body.pipeThrough(new TextEncoderStream()), { headers });
    },
    close() {
      closed = true;
      for (const r of readers) try { r.close(); } catch { /* that reader left */ }
      readers.clear();
      said.length = 0;
    },
  };
}
