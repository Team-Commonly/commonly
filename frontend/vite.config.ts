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
    // same-origin — fine on app.* hosts but broken on the apex (commonly.me),
    // where the frontend host serves the SPA and does NOT proxy /api, so every
    // logged-in API call hit the SPA instead of the backend. The Dockerfile +
    // CI already pass REACT_APP_API_URL=https://api.commonly.me as a build ENV;
    // pass it through explicitly (a longer define key wins over `process.env`)
    // so the app actually reads it. Empty string when unset keeps self-hosted
    // same-origin builds on their existing fallback path.
    'process.env.REACT_APP_API_URL': JSON.stringify(process.env.REACT_APP_API_URL || ''),
    // Same `process.env: {}` clobber trap as REACT_APP_API_URL above: without an
    // explicit define, the showcase pod id fell back to the literal
    // '__SHOWCASE_POD_ID__' placeholder, so /api/showcase/__SHOWCASE_POD_ID__ 404s
    // and the public "Watch a live room" CTA renders "This room isn't public".
    // CI passes REACT_APP_SHOWCASE_POD_ID as a build ENV; pass it through here.
    'process.env.REACT_APP_SHOWCASE_POD_ID': JSON.stringify(process.env.REACT_APP_SHOWCASE_POD_ID || ''),
    // Keep the deployed short SHA available to in-app bug reports. Without an
    // explicit define, the broad process.env replacement below erases it.
    'process.env.REACT_APP_VERSION': JSON.stringify(process.env.REACT_APP_VERSION || ''),
    // Error tracking is opt-in at build time. An empty value lets Rollup remove
    // the guarded dynamic import, keeping the SDK out of self-hosted bundles.
    'process.env.REACT_APP_SENTRY_DSN': JSON.stringify(process.env.REACT_APP_SENTRY_DSN || ''),
    'process.env': {},
  },
});
