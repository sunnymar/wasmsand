import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'node-adapter': 'src/node-adapter.ts',
    'browser-adapter': 'src/browser-adapter.ts',
    'execution-worker': 'src/execution/execution-worker.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  async onSuccess() {
    // Copy python-shims/ to dist/ (not bundleable — read at runtime via readFileSync)
    const { readFileSync, writeFileSync, readdirSync, cpSync } = await import('fs');
    const { join } = await import('path');
    const dir = join(import.meta.dirname!, 'dist');
    const builtins = ['worker_threads', 'fs/promises', 'fs', 'path', 'os', 'url',
      'events', 'stream', 'buffer', 'util', 'crypto', 'http', 'https', 'net',
      'tls', 'child_process', 'process'];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const fp = join(dir, f);
      let text = readFileSync(fp, 'utf8');
      let changed = false;
      for (const mod of builtins) {
        const re = new RegExp(`(import\\(|from )["']${mod.replace('/', '\\/')}["']`, 'g');
        const replaced = text.replace(re, (m, prefix) => {
          if (m.includes('node:')) return m;
          changed = true;
          return `${prefix}"node:${mod}"`;
        });
        text = replaced;
      }
      if (changed) writeFileSync(fp, text);
    }

    // Copy python-shims to dist/ so readFileSync at runtime can find them
    const shimSrc = join(import.meta.dirname!, 'src', 'network', 'python-shims');
    const shimDst = join(dir, 'python-shims');
    cpSync(shimSrc, shimDst, { recursive: true });
  },
});
