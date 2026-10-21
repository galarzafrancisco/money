/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The web app must be same-site with the backend (docs/web-auth.md): in
 * production the backend serves dist/; in development Vite proxies /api and
 * /auth to it. Set WEB_APP_URL=http://localhost:5173 on the backend so sign-in
 * returns here.
 */
const backend = process.env.MONEY_BACKEND_URL ?? 'http://localhost:4180';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/auth': { target: backend, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
