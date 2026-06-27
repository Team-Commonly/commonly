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
    'process.env': {},
  },
});
