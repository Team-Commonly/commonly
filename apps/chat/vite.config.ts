import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The API origin is baked in at build time. Cloudflare Pages sets
// VITE_API_URL per environment; local dev leaves it empty and proxies /api
// and /socket.io to production so the app runs against real data.
const apiUrl = process.env.VITE_API_URL || '';
const proxyTarget = process.env.DEV_PROXY_TARGET || 'https://api.commonly.me';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@commonly/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
  },
  server: {
    port: 3200,
    strictPort: true,
    proxy: apiUrl ? undefined : {
      '/api': { target: proxyTarget, changeOrigin: true, secure: true },
      '/socket.io': { target: proxyTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
});
