import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      '@codepod/sandbox': resolve(__dirname, '../orchestrator/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      // The Sandbox class has a dynamic import of node-adapter.ts (for auto-detection).
      // That path is never hit in the browser, but Rollup still follows it.
      // Mark node: builtins as external so the build succeeds.
      external: [/^node:/],
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
