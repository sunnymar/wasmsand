import { Sandbox, BrowserAdapter } from '@codepod/sandbox';

const WASM_BASE = `${import.meta.env.BASE_URL}wasm`.replace(/\/\//g, '/');

// Exported for testing — maps Vite glob keys to /src/ VFS paths
export function buildVfsPaths(glob: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, content] of Object.entries(glob)) {
    // key is like './main.tsx' or './components/Chat.tsx'
    const rel = key.startsWith('./') ? key.slice(2) : key;
    out[`/src/${rel}`] = content;
  }
  return out;
}

export async function initSandbox(): Promise<Sandbox> {
  const adapter = new BrowserAdapter();

  // Import all source files at build time.
  // The glob './**/*' from src/sandbox.ts resolves to src/**/* — it intentionally
  // captures everything in src/ including tests and this file itself.
  // That's fine: the VFS is just a read-only exploration surface for the LLM.
  // Vite 6: `as: 'raw'` was removed; use query + import instead.
  const sources = import.meta.glob('./**/*.{ts,tsx,css,html}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  const vfsPaths = buildVfsPaths(sources);

  const sandbox = await Sandbox.create({
    adapter,
    wasmDir: WASM_BASE,
  });

  // Create directories needed for VFS paths (Sandbox.create() only provides /tmp, /etc, etc.)
  const dirs = new Set<string>();
  for (const path of Object.keys(vfsPaths)) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      dirs.add('/' + parts.slice(0, i).join('/'));
    }
  }
  for (const dir of [...dirs].sort()) {
    try { sandbox.mkdir(dir); } catch { /* already exists */ }
  }

  const enc = new TextEncoder();
  for (const [path, content] of Object.entries(vfsPaths)) {
    // writeFile is synchronous (in-memory VFS mutation) — no await needed
    sandbox.writeFile(path, enc.encode(content));
  }

  return sandbox;
}

export async function runBash(
  sandbox: Sandbox,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.run(command);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
  };
}
