// Classify every v2.css selector by surface: live DOM regions (prod) + source references (import graph).
import fs from 'node:fs'; import path from 'node:path';
const [,, SRC, RULES, LIVE, OUT] = process.argv; // SRC = frontend/src
const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
const SURFACES = ['agentSettings', 'settings', 'memory', 'board', 'chat', 'sidebar', 'connectors'];
const ENTRIES = {
  board: ['v2/components/V2PodBoard.tsx'],
  chat: ['v2/components/V2Thread.tsx', 'v2/components/V2Inspector.tsx'],
  sidebar: ['v2/components/V2NavRail.tsx', 'v2/components/V2PodsSidebar.tsx', 'v2/components/V2MobileTabs.tsx'],
  settings: ['v2/components/V2SettingsPage.tsx'],
  agentSettings: ['v2/agents/V2AgentSettingsPage.tsx'],
  memory: ['v2/agents/V2AgentMemory.tsx'],
  connectors: ['v2/connectors/ConnectorsPage.tsx'],
  other: ['V2ActivityPage', 'V2ArtifactsPage', 'V2YourTeamPage', 'V2AgentBYO', 'V2ConnectPage', 'V2Login', 'V2Register', 'V2ForgotPassword', 'V2ResetPassword', 'V2OAuthComplete', 'V2InviteRedeem', 'V2CliAuthorize', 'V2AdminUsers', 'V2AdminAnalytics', 'V2FeaturePage', 'V2TaskRecord', 'V2RunTrace', 'V2FirstRunHero', 'V2EmailVerificationBanner'].map(n => `v2/components/${n}.tsx`)
    .concat(['v2/agents/V2AgentProfile.tsx', 'v2/landing/V2LandingPage.tsx', 'v2/legal/V2LegalPage.tsx', 'v2/primitives/V2PrimitivesPage.tsx']),
  shell: ['v2/V2App.tsx', 'v2/components/V2Layout.tsx'],
};
// source files
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/__tests__|__mocks__|__testkit__/.test(e.name)) walk(p); } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) files.push(p); } })(SRC);
const rel = (p) => path.relative(SRC, p);
const tests = []; (function walkT(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkT(p); else if (/\.test\.(tsx?|jsx?)$/.test(e.name)) { const t = fs.readFileSync(p, 'utf8'); if (t.includes('v2.css')) tests.push([path.relative(SRC, p), t]); } } })(SRC);
const text = Object.fromEntries(files.map(f => [rel(f), fs.readFileSync(f, 'utf8')]));
const resolveImp = (from, spec) => { if (!spec.startsWith('.')) return null; const b = path.join(path.dirname(from), spec); for (const c of [b, b + '.tsx', b + '.ts', b + '.jsx', b + '.js', b + '/index.tsx', b + '/index.ts']) if (text[c] !== undefined) return c; return null; };
const imports = {}; for (const [f, t] of Object.entries(text)) imports[f] = [...t.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map(m => resolveImp(f, m[1])).filter(Boolean);
const entryOf = {}; for (const [s, es] of Object.entries(ENTRIES)) for (const e of es) { if (text[e] === undefined) console.error('missing entry', e); entryOf[e] = s; }
const fileSurf = {};
for (const [s, es] of Object.entries(ENTRIES)) for (const e of es) { const seen = new Set([e]); const q = [e]; while (q.length) { const f = q.pop(); (fileSurf[f] ||= new Set()).add(s); for (const n of imports[f] || []) if (!seen.has(n) && !(entryOf[n] && entryOf[n] !== s)) { seen.add(n); q.push(n); } } }
for (const f of Object.keys(text)) if (!fileSurf[f]) fileSurf[f] = new Set([f.startsWith('v2/') ? 'shell' : 'legacy']);
// subject classes of a selector
// Subject = the classes on the rightmost compound that has a v2 class (MUI classes are generated, never literal).
const subject = (sel) => { const parts = sel.split(/\s*[>+~]\s*|\s+(?![^(]*\))/).filter(Boolean); for (let i = parts.length - 1; i >= 0; i--) { const cls = [...parts[i].replace(/:(not|is|where|has)\([^)]*\)/g, '').matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]).filter(c => c.startsWith('v2')); if (cls.length) return cls; } return []; };
const refCache = {};
const refsOf = (cls) => { if (refCache[cls]) return refCache[cls]; const out = new Set(); const re = new RegExp(`(^|[^a-zA-Z0-9_-])${cls.replace(/[-]/g, '\\-')}(?![a-zA-Z0-9_])`); // Every separator prefix is a possible template stem: v2-board__owner-dot--${state} builds v2-board__owner-dot--not-claimed.
  const stems = [...cls.matchAll(/--|__|-/g)].map(m => cls.slice(0, m.index + m[0].length)).filter(st => st.length > 3);
  for (const [f, t] of Object.entries(text)) { if (re.test(t) || stems.some(st => t.includes(st + '${') || t.includes(`'${st}' +`) || t.includes(`"${st}" +`))) out.add(f); }
  return (refCache[cls] = out); };
const liveOf = {}; const liveKeys = {};
for (const [k, m] of Object.entries(live)) for (const [s, regs] of Object.entries(m)) { for (const r of regs.filter(x => !x.startsWith('!'))) (liveOf[s] ||= new Set()).add(r); (liveKeys[s] ||= new Set()).add(k.split('@')[0]); }
const rows = [];
for (const r of rules) for (const s of r.selectors) {
  const cls = subject(s);
  const files = new Set(); for (const c of cls) for (const f of refsOf(c)) files.add(f);
  const src = new Set(); for (const f of files) for (const x of fileSurf[f]) src.add(x);
  const lv = liveOf[s] || new Set();
  const all = new Set([...src, ...lv]);
  // A test pins a selector when it names the subject class as a CSS class, plain or regex-escaped.
  const pins = tests.filter(([, t]) => t.includes(s) || cls.some(c => new RegExp(`\\\\?\\.${c.replace(/-/g, '\\-')}(?![a-zA-Z0-9_-])`).test(t))).map(([f]) => path.basename(f));
  rows.push({ pins, line: r.line, end: r.endLine, media: r.media, sel: s, cls, live: [...lv].sort(), src: [...src].sort(), files: [...files].sort(), all: [...all].sort(), ruleSels: r.selectors.length });
}
fs.writeFileSync(OUT, JSON.stringify(rows));
const verdict = (row) => row.all.length === 0 ? 'dead' : row.all.length === 1 ? (SURFACES.includes(row.all[0]) ? 'only:' + row.all[0] : 'only:' + row.all[0]) : 'shared';
const c = {}; for (const row of rows) { const v = verdict(row); c[v] = (c[v] || 0) + 1; }
console.log(JSON.stringify(c, null, 1));
for (const s of SURFACES) { const sh = rows.filter(r => r.all.length > 1 && r.all.includes(s)).length; console.log(s, 'only', c['only:' + s] || 0, 'shared-with-others', sh); }
