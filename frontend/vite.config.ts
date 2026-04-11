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
    // CRA used process.env.REACT_APP_* — keep compatibility
    'process.env': {},
  },
});
