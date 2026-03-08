import { VFS, ProcessManager, ShellInstance, BrowserAdapter } from '@codepod/sandbox';
import { createTerminal } from './terminal.js';
import '@xterm/xterm/css/xterm.css';

const WASM_BASE = `${import.meta.env.BASE_URL}wasm`.replace(/\/\//g, '/');

async function boot(): Promise<void> {
  const vfs = new VFS();
  const adapter = new BrowserAdapter();
  const mgr = new ProcessManager(vfs, adapter);

  // Register all tools via the adapter's canonical list
  const tools = await adapter.scanTools(WASM_BASE);
  for (const [name, url] of tools) {
    mgr.registerTool(name, url);
  }

  // Register python3 + python alias via symlink
  mgr.registerTool('python3', `${WASM_BASE}/python3.wasm`);
  vfs.withWriteAccess(() => vfs.symlink('/usr/bin/python3', '/usr/bin/python'));

  // Pre-load all tool modules so spawnSync can use them synchronously
  await mgr.preloadModules();

  const shellWasmUrl = `${WASM_BASE}/codepod-shell-exec.wasm`;

  // Use async spawning when JSPI is available (avoids V8 8MB sync-instantiation
  // limit for large modules like python3.wasm). Fall back to syncSpawn on older
  // browsers without JSPI support.
  const hasJSPI = typeof WebAssembly.Suspending === 'function';
  const runner = await ShellInstance.create(vfs, mgr, adapter, shellWasmUrl, {
    ...(!hasJSPI && {
      syncSpawn: (cmd: string, args: string[], env: Record<string, string>, stdin: Uint8Array, cwd: string) =>
        mgr.spawnSync(cmd, args, env, stdin, cwd),
    }),
  });

  const container = document.getElementById('terminal');
  if (!container) throw new Error('Missing #terminal element');

  createTerminal(container, runner);
}

boot().catch((err) => {
  document.body.textContent = `Boot failed: ${err.message}`;
  console.error(err);
});
