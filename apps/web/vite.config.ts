import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// During development the React app runs on Vite's dev server (port 5173) and
// proxies /api calls to the Fastify server on port 3000. In production the
// Fastify server serves the built files directly, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind on all interfaces (0.0.0.0) so other devices on the LAN/hotspot —
    // e.g. a phone testing the mobile layout — can reach the dev server by the
    // laptop's IP. Without this Vite only listens on localhost.
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
