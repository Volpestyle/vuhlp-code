import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import checker from 'vite-plugin-checker';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    checker({
      typescript: {
        tsconfigPath: './tsconfig.app.json',
      },
    }),
  ],
  optimizeDeps: {
    rolldownOptions: {}
  },
  resolve: {
    alias: {
      '@vuhlp/ui/styles': path.resolve(__dirname, '../../../packages/ui/src/styles/index.css'),
      '@vuhlp/ui': path.resolve(__dirname, '../../../packages/ui/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4317',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:4317',
        ws: true,
      },
    },
  },
});
