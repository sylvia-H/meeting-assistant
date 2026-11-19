import { defineConfig } from 'vite';

const API_PORT = process.env.PORT ?? '8787';

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}` },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
    },
  },
});
