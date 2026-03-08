import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'node-adapter': 'src/node-adapter.ts',
    'browser-adapter': 'src/browser-adapter.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  async onSuccess() {
    // esbuild strips node: prefix on dynamic imports; restore it for deno compat.
    const { readFileSync, writeFileSync, readdirSync } = await import('fs');
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
  },
});
