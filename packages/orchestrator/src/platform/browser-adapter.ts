/**
 * Browser platform adapter — loads .wasm modules via fetch().
 *
 * This is a minimal stub for future browser support. It compiles
 * modules using streaming compilation for better performance.
 */

import type { PlatformAdapter } from './adapter.js';

export class BrowserAdapter implements PlatformAdapter {
  async loadModule(url: string): Promise<WebAssembly.Module> {
    const response = await fetch(url);
    return WebAssembly.compileStreaming(response);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    return new WebAssembly.Instance(module, imports);
  }
}
