import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';
import fs from 'fs';
import path from 'path';

/**
 * The connect flow used to promise more than it delivered.
 *
 * Measured on production 2026-08-09: 4 of 6 human @mentions in ten days got no
 * reply. The cause was not user error — the web BYO flow wires MCP, which lets
 * an agent CALL Commonly from the user's editor, and nothing in that path
 * listens for mentions. `commonly agent run` (the wrapper that polls) was a
 * footnote. Users finished in two minutes, saw the agent in Your Team, spoke to
 * it, and got silence. See #887.
 *
 * These pin the two claims that fix it, in both languages, because both users
 * who hit this were writing Chinese.
 */

const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');

describe('the connect flow states what it does not do', () => {
  describe.each([['en', en as any], ['zh-CN', zhCN as any]])('%s', (_locale, bundle) => {
    const listen = bundle.agentByo?.listen;

    test('a listening step exists at all', () => {
      expect(listen?.title).toBeTruthy();
      expect(listen?.body).toBeTruthy();
      expect(listen?.note).toBeTruthy();
    });

    test('it says plainly that MCP alone will not answer mentions', () => {
      const all = `${listen.title} ${listen.body} ${listen.note}`;
      // The whole point: name the gap rather than only describing the fix.
      expect(all).toMatch(/@|提及/);
      expect(all.length).toBeGreaterThan(60);
    });

    test('the note names the agent, so the consequence is concrete', () => {
      expect(listen.note).toMatch(/\{\{name\}\}/);
    });
  });

  test('an agent that never connected does not read as merely quiet', () => {
    // Conflating them is how 13 unreachable installs sat in Your Team looking
    // healthy next to working agents.
    expect(en.yourTeam.activity.neverConnected).toBeTruthy();
    expect(zhCN.yourTeam.activity.neverConnected).toBeTruthy();
    expect(en.yourTeam.activity.neverConnected).not.toBe(en.yourTeam.activity.noRecent);
    expect(zhCN.yourTeam.activity.neverConnected).not.toBe(zhCN.yourTeam.activity.noRecent);
  });

  test('internal seats are named as connected agents in both locales', () => {
    expect(en.yourTeam.tiers.internal).toBe('Connected agents');
    expect(en.yourTeam.tiers.internalCount).toBe('Connected agents ({{count}})');
    expect(zhCN.yourTeam.tiers.internal).toBe('已连接的智能体');
    expect(zhCN.yourTeam.tiers.internalCount).toBe('已连接的智能体（{{count}}）');
  });

  test('Your Team renders the never-connected state for a null heartbeat', () => {
    const src = read('../components/V2YourTeamPage.tsx');
    // `lastHeartbeatAt` is derived from heartbeat events, so null means the
    // wrapper was never started — not that the agent is idle.
    expect(src).toMatch(/if \(!iso\) return t\('yourTeam\.activity\.neverConnected'\)/);
  });

  test('Your Team derives last-seen from lastActiveAt, not heartbeats alone (#915)', () => {
    const src = read('../components/V2YourTeamPage.tsx');
    // Heartbeat-only derivation showed the native Guide as "Never connected"
    // minutes after it replied. lastActiveAt (max across heartbeats, token
    // use, AgentRuns) must be the primary source with heartbeat fallback.
    expect(src).toMatch(/a\.lastActiveAt \?\? a\.lastHeartbeatAt/);
    expect(src).toMatch(/formatRelative\(lastSeenIso\(a\), t\)/);
  });

  test('the BYO page ships the command that makes an agent listen', () => {
    const src = read('../components/V2AgentBYO.tsx');
    expect(src).toMatch(/commonly agent run/);
    expect(src).toMatch(/agentByo\.listen\.title/);
  });

  test('the device-login verify page the backend points at exists as a frontend route', () => {
    // #1534 deleted /cli/authorize as "retired UI" while backend/routes/auth.ts
    // still answered device/start with `verifyUrl: <origin>/cli/authorize`, so
    // every `commonly login` 404'd for four days. The backend path is the source;
    // the route must match it.
    const backendAuth = fs.readFileSync(path.join(__dirname, '../../../../backend/routes/auth.ts'), 'utf8');
    const verify = backendAuth.match(/verifyUrl: `\$\{origin\}(\/[^`]+)`/);
    expect(verify).not.toBeNull();
    const app = read('../../App.tsx');
    expect(app).toContain(`<Route path="${verify![1]}" element={<V2CliAuthorize />} />`);
  });

  test('nginx lets the two URLs the backend and CLI print reach the app', () => {
    // The real-404 change (58294673, 2026-08-24) made nginx an allowlist of
    // SPA routes. /cli/authorize was never on it, so the device-code login
    // 404'd in the browser from that day — the React route restore (#1627)
    // alone changed nothing live. Same for /settings/devices, which the CLI
    // prints after a login. The regex is read from the real config and run.
    const nginx = fs.readFileSync(path.join(__dirname, '../../../nginx.conf'), 'utf8');
    const location = nginx.match(/location ~ \^\/\((.*)\) \{\n\s*try_files \$uri \$uri\/ \/index\.html;/);
    expect(location).not.toBeNull();
    const spa = new RegExp(`^/(${location![1]})`);
    const backendAuth = fs.readFileSync(path.join(__dirname, '../../../../backend/routes/auth.ts'), 'utf8');
    const verify = backendAuth.match(/verifyUrl: `\$\{origin\}(\/[^`]+)`/)![1];
    const cliLogin = fs.readFileSync(path.join(__dirname, '../../../../cli/src/commands/login.js'), 'utf8');
    const devices = cliLogin.match(/new URL\('(\/[^']+)'/)![1];
    for (const route of [verify, devices, '/verify-email', '/v2/settings']) {
      expect(spa.test(route)).toBe(true);
    }
    expect(spa.test('/definitely-not-a-route')).toBe(false);
  });
});
