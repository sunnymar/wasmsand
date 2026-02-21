/**
 * Node.js platform adapter — loads .wasm modules from the local filesystem.
 */

import { readFile } from 'node:fs/promises';

import type { PlatformAdapter } from './adapter.js';

export class NodeAdapter implements PlatformAdapter {
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
}
