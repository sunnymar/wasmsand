import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

// Stub Node builtins that get pulled into the browser bundle via Node-only
// code paths (PackageRegistry, FsBackend, HostFsProvider) that are never
// called in the browser.
function nodeStubs() {
  const stubs: Record<string, string> = {
    'node:fs': 'export function readFileSync(){} export function readdirSync(){return []} export function statSync(){} export function readdir(){} export function readFile(){} export function writeFileSync(){} export function mkdirSync(){} export function rmSync(){} export function mkdtemp(){} export function rm(){} export function existsSync(){return false} export default {}',
    'node:fs/promises': 'export function readFile(){} export function writeFile(){} export function mkdir(){} export function unlink(){} export function readdir(){} export default {}',
    'node:path': 'export function resolve(...a){return a.join("/")} export function join(...a){return a.join("/")} export function relative(){return ""} export function dirname(p){return p} export function normalize(p){return p} export default {}',
    'node:os': 'export function homedir(){return "/"} export function tmpdir(){return "/tmp"} export default {}',
    'node:worker_threads': 'export const parentPort = null; export default {}',
    'node:readline': 'export function createInterface(){return {}} export default {}',
    'node:url': 'export function fileURLToPath(u){return u} export default {}',
    'node:child_process': 'export function spawn(){return {}} export default {}',
  };
  return {
    name: 'node-stubs',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (stubs[id]) return `\0node-stub:${id}`;
    },
    load(id: string) {
      if (id.startsWith('\0node-stub:')) return stubs[id.slice('\0node-stub:'.length)];
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), nodeStubs()],
  resolve: {
    alias: {
      '@codepod/sandbox': resolve(__dirname, '../../packages/orchestrator/src/index.ts'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Vitest config (co-located to avoid a separate vitest.config.ts)
  test: {
    environment: 'node',
  },
});
