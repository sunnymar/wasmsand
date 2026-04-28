import { BrowserAdapter, Sandbox } from '@codepod/sandbox';
import { createTerminal } from './terminal.js';
import '@xterm/xterm/css/xterm.css';

const WASM_BASE = `${import.meta.env.BASE_URL}wasm`.replace(/\/\//g, '/');

async function boot(): Promise<void> {
  const adapter = new BrowserAdapter();
  const sandbox = await Sandbox.create({
    wasmDir: WASM_BASE,
    adapter,
    network: { allowedHosts: ['*'] },
  });

  // Write a sample file for curl/wget demos
  sandbox.mkdir('/var');
  sandbox.mkdir('/var/www');
  sandbox.writeFile(
    '/var/www/hello.txt',
    new TextEncoder().encode(
      'Hello from codepod!\nThis file lives in the in-memory filesystem.\n',
    ),
  );

  const container = document.getElementById('terminal');
  if (!container) throw new Error('Missing #terminal element');

  createTerminal(container, sandbox);
}

boot().catch((err) => {
  const el = document.getElementById('boot-error');
  if (el) {
    el.textContent = `Boot failed: ${err.message}`;
    el.style.display = 'block';
  }
  console.error(err);
});
