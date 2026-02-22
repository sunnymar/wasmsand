import { VFS, ProcessManager, ShellRunner, BrowserAdapter } from '@wasmsand/orchestrator';
import { createTerminal } from './terminal.js';
import '@xterm/xterm/css/xterm.css';

const WASM_BASE = '/wasm';

const TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf', 'find', 'sed', 'awk', 'jq',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr', 'diff',
];

/** Map tool name to wasm filename. */
function wasmUrl(tool: string): string {
  return `${WASM_BASE}/${tool}.wasm`;
}

async function boot(): Promise<void> {
  const vfs = new VFS();
  const adapter = new BrowserAdapter();
  const mgr = new ProcessManager(vfs, adapter);

  // Register coreutils
  for (const tool of TOOLS) {
    mgr.registerTool(tool, wasmUrl(tool));
  }

  // true/false have special wasm filenames
  mgr.registerTool('true', `${WASM_BASE}/true-cmd.wasm`);
  mgr.registerTool('false', `${WASM_BASE}/false-cmd.wasm`);

  // Register python3
  mgr.registerTool('python3', `${WASM_BASE}/python3.wasm`);

  const shellWasmUrl = `${WASM_BASE}/wasmsand-shell.wasm`;
  const runner = new ShellRunner(vfs, mgr, adapter, shellWasmUrl);

  const container = document.getElementById('terminal');
  if (!container) throw new Error('Missing #terminal element');

  createTerminal(container, runner);
}

boot().catch((err) => {
  document.body.textContent = `Boot failed: ${err.message}`;
  console.error(err);
});
