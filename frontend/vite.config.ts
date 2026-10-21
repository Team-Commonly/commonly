import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    open: false,
  },
  build: {
    outDir: 'build', // match CRA output dir for deployment compatibility
  },
  define: {
    // CRA used process.env.REACT_APP_* — keep compatibility. The bare
    // `process.env: {}` replacement clobbers ALL process.env access at build
    // time, which silently zeroed out the API base: getApiBaseUrl() reads
    // `process.env.REACT_APP_API_URL` first, got undefined, and fell back to
    // same-origin. When that happened (2026), the apex did not route /api to the
    // backend, so every logged-in API call hit the SPA. The apex routes /api and
    // /socket.io to the backend since the same-origin change (2026-10), and CI
    // now passes REACT_APP_API_URL=https://commonly.me on purpose; pass it
    // through explicitly (a longer define key wins over `process.env`) so the
    // app reads exactly what the build was given. Empty string when unset keeps
    // self-hosted builds on their existing fallback path.
    'process.env.REACT_APP_API_URL': JSON.stringify(process.env.REACT_APP_API_URL || ''),
    // The API's own host, for the calls that must stay there (utils/apiBaseUrl.ts
    // getApiAliasUrl): OAuth starts and the connector calls whose cookies the
    // vendor's callback must carry. Empty when unset, which falls back to the base.
    'process.env.REACT_APP_API_ALIAS_URL': JSON.stringify(process.env.REACT_APP_API_ALIAS_URL || ''),
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
    'process.env': {},
  },
});
