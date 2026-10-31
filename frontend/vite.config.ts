import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev:live` (TASK-686): serve the branch on localhost:3000 and proxy
// /api and /socket.io to a real backend. The browser's Origin header is
// dropped on the way out, because prod refuses http://localhost:3000 and the
// backend accepts no-Origin requests. Target defaults to staging, where writes
// are safe; DEV_LIVE_TARGET=prod points at prod, read-only, see TESTING.md.
const DEV_LIVE = process.env.DEV_LIVE === '1';
const LIVE_TARGETS: Record<string, string> = {
  staging: 'https://api-staging.commonly.me',
  prod: 'https://api.commonly.me',
};
const liveName = process.env.DEV_LIVE_TARGET || 'staging';
const liveTarget = LIVE_TARGETS[liveName];
if (DEV_LIVE && !liveTarget) {
  throw new Error(`DEV_LIVE_TARGET must be one of: ${Object.keys(LIVE_TARGETS).join(', ')}`);
}
const dropOrigin: NonNullable<ProxyOptions['configure']> = (proxy) => {
  proxy.on('proxyReq', (req) => req.removeHeader('origin'));
  proxy.on('proxyReqWs', (req) => req.removeHeader('origin'));
};
// Prod is read-only for the browser: HTTP writes are refused at the proxy and
// the socket is not proxied, so the page renders from REST GETs only.
const readOnlyProd = liveName === 'prod';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    open: false,
    proxy: DEV_LIVE
      ? {
          '/api': {
            target: liveTarget,
            changeOrigin: true,
            secure: true,
            configure: dropOrigin,
            bypass: (req) => (readOnlyProd && req.method !== 'GET' && req.method !== 'HEAD' ? '/__dev-live-read-only' : undefined),
          },
          ...(readOnlyProd
            ? {}
            : {
                '/socket.io': {
                  target: liveTarget,
                  changeOrigin: true,
                  secure: true,
                  ws: true,
                  configure: dropOrigin,
                },
              }),
        }
      : undefined,
  },
  build: {
    outDir: 'build', // match CRA output dir for deployment compatibility
  },
  define: {
    // CRA used process.env.REACT_APP_* — keep compatibility. The bare
    // `process.env: {}` replacement clobbers ALL process.env access at build
    // time, which silently zeroed out the API base: getApiBaseUrl() reads
    // `process.env.REACT_APP_API_URL` first, got undefined, and fell back to
    // same-origin — fine on app.* hosts but broken on the apex (commonly.me),
    // where the frontend host serves the SPA and does NOT proxy /api, so every
    // logged-in API call hit the SPA instead of the backend. The Dockerfile +
    // CI already pass REACT_APP_API_URL=https://api.commonly.me as a build ENV;
    // pass it through explicitly (a longer define key wins over `process.env`)
    // so the app actually reads it. Empty string when unset keeps self-hosted
    // same-origin builds on their existing fallback path.
    'process.env.REACT_APP_API_URL': JSON.stringify(process.env.REACT_APP_API_URL || ''),
    'process.env.REACT_APP_TELEGRAM_BOT_HANDLE': JSON.stringify(process.env.REACT_APP_TELEGRAM_BOT_HANDLE || ''),
    // Same `process.env: {}` clobber trap as REACT_APP_API_URL above: without an
    // explicit define, the showcase pod id fell back to the literal
    // '__SHOWCASE_POD_ID__' placeholder, so /api/showcase/__SHOWCASE_POD_ID__ 404s
    // and the public "Watch a live room" CTA renders "This room isn't public".
    // CI passes REACT_APP_SHOWCASE_POD_ID as a build ENV; pass it through here.
    'process.env.REACT_APP_SHOWCASE_POD_ID': JSON.stringify(process.env.REACT_APP_SHOWCASE_POD_ID || ''),
    // Hosted Community navigation is configured at build time and omitted
    // entirely from self-hosted rails when no pod id is supplied.
    'process.env.REACT_APP_COMMUNITY_POD_ID': JSON.stringify(process.env.REACT_APP_COMMUNITY_POD_ID || ''),
    'process.env.REACT_APP_COMMUNITY_INVITE_TOKEN': JSON.stringify(process.env.REACT_APP_COMMUNITY_INVITE_TOKEN || ''),
    // Keep the deployed short SHA available to in-app bug reports. Without an
    // explicit define, the broad process.env replacement below erases it.
    'process.env.REACT_APP_VERSION': JSON.stringify(process.env.REACT_APP_VERSION || ''),
    // Error tracking is opt-in at build time. An empty value lets Rollup remove
    // the guarded dynamic import, keeping the SDK out of self-hosted bundles.
    'process.env.REACT_APP_SENTRY_DSN': JSON.stringify(process.env.REACT_APP_SENTRY_DSN || ''),
    // Developer apps flag (TASK-674). Unset in CI and deploy, so prod stays off.
    'process.env.REACT_APP_DEVELOPER_APPS': JSON.stringify(process.env.REACT_APP_DEVELOPER_APPS || ''),
    'process.env': {},
  },
});
