import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://100.92.179.102:4000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://100.92.179.102:4000',
        ws: true,
      },
    },
  },
});
