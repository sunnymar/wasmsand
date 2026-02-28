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

  // Register python3
  mgr.registerTool('python3', `${WASM_BASE}/python3.wasm`);

  const shellWasmUrl = `${WASM_BASE}/codepod-shell-exec.wasm`;
  const runner = await ShellInstance.create(vfs, mgr, adapter, shellWasmUrl, {
    syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
  });

  const container = document.getElementById('terminal');
  if (!container) throw new Error('Missing #terminal element');

  createTerminal(container, runner);
}

boot().catch((err) => {
  document.body.textContent = `Boot failed: ${err.message}`;
  console.error(err);
});
