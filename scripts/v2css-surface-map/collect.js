// In-page: for each v2.css selector, which regions hold a matching element right now.
// Arg: { sels: string[], route: surface label for the main pane and portals }.
({ sels, route }) => {
  const norm = (s) => s
    .replace(/:root\[data-v2-theme[^\]]*\]/g, ':root')
    .replace(/:root:not\(\[data-v2-theme[^\]]*\]\)/g, ':root')
    .replace(/\[data-v2-theme[^\]]*\]/g, '')
    .replace(/::?(before|after|placeholder|selection|marker|backdrop|-webkit-[a-z-]+|-moz-[a-z-]+)(\([^)]*\))?/g, '')
    .replace(/:(hover|focus-visible|focus-within|focus|active|visited|target)\b/g, '')
    .replace(/:lang\([^)]*\)/g, '')
    .replace(/:(not|has)\(\s*\)/g, '')
    .replace(/:is\(\s*\)|:where\(\s*\)/g, '')
    .trim() || '*';
  const shell = document.querySelector('.v2-shell');
  const regionOf = (el) => {
    if (el.closest('.v2-pane--rail, .v2-pods-aside, .v2-mobile-tabs')) return 'sidebar';
    if (el.closest('.v2-pane--inspector')) return 'chat';
    if (el.closest('.v2-pane--main')) return route;
    if (shell && el.contains(shell)) return 'shell';
    if (el === document.documentElement || el === document.body) return 'shell';
    return route; // portals: dialogs, popovers, drawers opened from the page
  };
  const out = {};
  for (const s of sels) {
    let els;
    try { els = document.querySelectorAll(norm(s)); } catch (e) { out[s] = ['!invalid']; continue; }
    if (!els.length) continue;
    const r = new Set();
    for (const el of els) { r.add(regionOf(el)); if (r.size > 3) break; }
    out[s] = [...r];
  }
  return out;
}
