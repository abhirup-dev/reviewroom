// The on-screen keyboard on a phone shrinks the visual viewport, not the layout one, so anything fixed to the bottom
// of the screen would sit under it. While a caller tracks it, <html> carries --rr-kb (the keyboard's height) and
// --rr-kb-top (how far the browser panned the page to show the caret) for CSS to keep clear of. Any sheet (the
// thread popup, the palette) can track it; the properties go when the last one stops.
let users = 0;

export function trackKeyboard(onChange?: () => void): () => void {
  const v = window.visualViewport;
  if (!v) return () => {};
  const css = document.documentElement.style;
  const update = () => {
    css.setProperty('--rr-kb', Math.max(0, Math.round(innerHeight - v.height - v.offsetTop)) + 'px');
    css.setProperty('--rr-kb-top', Math.round(v.offsetTop) + 'px');
    onChange?.();
  };
  v.addEventListener('resize', update);
  v.addEventListener('scroll', update);
  users++;
  update();
  return () => {
    v.removeEventListener('resize', update);
    v.removeEventListener('scroll', update);
    if (--users) return;
    css.removeProperty('--rr-kb');
    css.removeProperty('--rr-kb-top');
  };
}
