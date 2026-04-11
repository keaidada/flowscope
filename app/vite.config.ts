import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  // Chrome extension requires relative paths (not absolute /assets/...)
  base: './',
  resolve: {
    alias: {
      '@pondpilot/flowscope-core': path.resolve(__dirname, '../packages/core/src'),
      '@pondpilot/flowscope-react': path.resolve(__dirname, '../packages/react/src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@pondpilot/flowscope-core', '@pondpilot/flowscope-react'],
  },
  build: {
    target: 'esnext',
    // Chrome extension: output to dist/ with no hash in filenames
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
