import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from '../cli/lib/render.ts';
import { read, setup } from './fixture.ts';
import { until } from '../src/testing/wait.ts';

const browser = process.platform === 'darwin' || !!(process.env.BUN_CHROME_PATH || Bun.which('chromium') || Bun.which('google-chrome'));

describe('built client author contract', () => {
  const { dir, serve, state } = setup();

  test.skipIf(!browser)('auto boot publishes a usable window.rr at ready and persists an author-script comment once', async () => {
    // openPage deliberately exposes only rendering operations. Have the actual author
    // script report its observations, rather than adding a second browser driver.
    let report: Record<string, unknown> | undefined;
    const receiver = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        report = await request.json() as Record<string, unknown>;
        return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
      },
    });
    const callback = `http://127.0.0.1:${receiver.port}/`;
    const authored = '<section id="contract"><h2>Authored section</h2><p>Keep <em>this content</em>.</p><button id="author-action">Author action</button></section>';
    const script = `<script>
      const authoredNode = document.querySelector('#contract');
      const authoredHTML = authoredNode.innerHTML;
      let readyCount = 0;
      let authorClicks = 0;
      document.querySelector('#author-action').onclick = () => authorClicks++;
      window.addEventListener('reviewroom:ready', async ({ detail: rr }) => {
        readyCount++;
        const result = {};
        try {
          result.sameAPI = rr === window.rr;
          result.methods = ['open','walkthrough','auditWalkthrough','findSymbol','read','files','search','comment','on','definePanel','addPanel','layout','toast','theme','markdown','tip'].filter(key => typeof rr[key] === 'function');
          result.commands = typeof rr.commands.run === 'function';
          result.theme = rr.theme();
          result.files = rr.files().length > 0;
          const file = rr.files().find(f => !f.binary && f.status !== 'deleted');
          result.read = typeof await rr.read(file.path) === 'string';
          result.search = Array.isArray(await rr.search('RecentEvents'));
          const docs = [];
          const off = rr.on('reveal-doc', target => docs.push(target.id));
          await rr.open('rr:doc/contract');
          off();
          await rr.open('rr:doc/contract');
          result.docs = docs;
          let notifications = 0;
          const stop = rr.on('state', () => notifications++);
          const thread = rr.comment('rr:doc/contract', 'Author API contract comment');
          result.thread = thread.anchor;
          result.notifications = notifications;
          stop();
          result.flushed = await rr.app.backend.flush();
          result.authoredSame = authoredNode === rr.app.doc.querySelector('#contract') && authoredNode.innerHTML === authoredHTML;
          document.querySelector('#author-action').click();
          result.authorClicks = authorClicks;
          result.readyCount = readyCount;
        } catch (error) { result.error = String(error.stack || error); }
        await fetch(${JSON.stringify(callback)}, { method: 'POST', body: JSON.stringify(result) });
      });
    </script>`;
    const template = read(import.meta.dir, '..', 'templates', 'review.html');
    fs.writeFileSync(path.join(dir, 'review.html'), template.replace(/\n  <rr-review>[\s\S]*?<\/rr-review>/, `\n  <rr-review>${authored}</rr-review>${script}`));
    let page: Awaited<ReturnType<typeof openPage>> | undefined;
    try {
      const url = await serve();
      const html = await (await fetch(url)).text();
      expect(html).toContain(authored);
      page = await openPage(url, { width: 1280, height: 800 });
      const result = await until(() => report, { timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ sameAPI: true, commands: true, files: true, read: true, search: true, docs: ['contract'], thread: { kind: 'doc', target: 'contract' }, notifications: 1, flushed: true, authoredSame: true, authorClicks: 1, readyCount: 1 });
      expect(result.methods).toEqual(['open','walkthrough','auditWalkthrough','findSymbol','read','files','search','comment','on','definePanel','addPanel','layout','toast','theme','markdown','tip']);
      expect(['light', 'dark']).toContain(String(result.theme));
      expect(state().threads.filter((thread: { messages: { body: string }[] }) => thread.messages.some((message) => message.body === 'Author API contract comment'))).toHaveLength(1);
      expect(page.errors()).toEqual([]);
    } finally {
      await page?.close();
      await receiver.stop(true);
    }
  }, 60_000);
});
