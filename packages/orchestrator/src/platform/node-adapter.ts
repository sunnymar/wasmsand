/**
 * Node.js platform adapter — loads .wasm modules from the local filesystem.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PlatformAdapter } from './adapter.js';

const EXCLUDED = new Set(['codepod-shell.wasm', 'python3.wasm']);

function wasmToToolName(filename: string): string {
  if (filename === 'true-cmd.wasm') return 'true';
  if (filename === 'false-cmd.wasm') return 'false';
  return filename.replace(/\.wasm$/, '');
}

export class NodeAdapter implements PlatformAdapter {
  supportsWorkerExecution = true;

  async loadModule(path: string): Promise<WebAssembly.Module> {
    const buffer = await readFile(path);
    return WebAssembly.compile(buffer);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    return new WebAssembly.Instance(module, imports);
  }

  async scanTools(wasmDir: string): Promise<Map<string, string>> {
    const entries = await readdir(wasmDir);
    const tools = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.endsWith('.wasm') || EXCLUDED.has(entry)) continue;
      const name = wasmToToolName(entry);
      tools.set(name, resolve(wasmDir, entry));
    }
    // gunzip is an alias for gzip (same binary, argv[0] detection)
    if (tools.has('gzip') && !tools.has('gunzip')) {
      tools.set('gunzip', tools.get('gzip')!);
    }
    return tools;
  }
}
