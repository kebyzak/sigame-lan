import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backend = 'http://localhost:3000';

export default defineConfig({
  root: 'src/client',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': backend,
      '/media': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
});
