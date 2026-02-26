/**
 * Browser platform adapter — loads .wasm modules via fetch().
 *
 * This is a minimal stub for future browser support. It compiles
 * modules using streaming compilation for better performance.
 */

import type { PlatformAdapter } from './adapter.js';

const BROWSER_TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf', 'find', 'sed', 'awk', 'jq',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr', 'diff',
  'du', 'df',
  'gzip', 'gunzip', 'tar',
  'true', 'false',
  'bc', 'dc', 'sqlite3',
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
  'rg',
];

function toolToWasmFile(name: string): string {
  if (name === 'true') return 'true-cmd.wasm';
  if (name === 'false') return 'false-cmd.wasm';
  if (name === 'gunzip') return 'gzip.wasm';
  return `${name}.wasm`;
}

export class BrowserAdapter implements PlatformAdapter {
  supportsWorkerExecution = false;

  async loadModule(url: string): Promise<WebAssembly.Module> {
    const response = await fetch(url);
    return WebAssembly.compileStreaming(response);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    // Must use async instantiate — sync `new WebAssembly.Instance()` is
    // disallowed on the main thread for modules larger than 8 MB.
    const result = await WebAssembly.instantiate(module, imports);
    return result;
  }

  async scanTools(wasmBase: string): Promise<Map<string, string>> {
    const tools = new Map<string, string>();
    for (const name of BROWSER_TOOLS) {
      tools.set(name, `${wasmBase}/${toolToWasmFile(name)}`);
    }
    return tools;
  }
}
