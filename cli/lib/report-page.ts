// The page a review is served as. reviewroom owns its shell (the head, the client entry, <rr-app>, <rr-review>);
// report.html holds only what the agent writes inside <rr-review>, so nothing an agent writes can stop the app booting.
// Older reports carry some or all of the shell themselves and still work.
import { PWA_HEAD } from './pwa.ts';

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${PWA_HEAD}<script type="module" src="_rr/reviewroom.js"></script>
`;

/** The review page for `report`: report.html's text, '' before there is one. No <title>: the client sets the review's. */
export function reportPage(report: string): string {
  if (report.includes('</head>')) return withHead(report); // a whole page, as reports were before the shell moved here
  const review = /<rr-review[\s>]/.test(report) ? report : `<rr-review>\n${report}\n</rr-review>`;
  const app = /<rr-app[\s>]/.test(report) ? report : `<rr-app>\n${review}\n</rr-app>`;
  return `<!doctype html>\n<html lang="en">\n<head>\n${HEAD}</head>\n<body>\n${app}\n</body>\n</html>\n`;
}

/** Adds what a whole page's <head> lacks: viewport-fit=cover, the PWA tags, the client entry. */
function withHead(html: string) {
  const end = html.indexOf('</head>');
  let head = html.slice(0, end).replace(/(<meta name="viewport" content="(?![^"]*viewport-fit)[^"]*)"/, '$1, viewport-fit=cover"');
  if (!head.includes('rel="manifest"')) head += PWA_HEAD;
  // the client build loads relatively, so under the hub's /r/<id>/ the page gets this server's build, not the hub's
  head = head.replace(/(src=["'])\/_rr\/reviewroom\.js/, '$1_rr/reviewroom.js');
  if (!head.includes('_rr/reviewroom.js')) head += '<script type="module" src="_rr/reviewroom.js"></script>\n';
  return head + html.slice(end);
}
