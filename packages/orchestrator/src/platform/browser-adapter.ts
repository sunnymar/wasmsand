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
    // Must use async instantiate — sync `new WebAssembly.Instance()` is
    // disallowed on the main thread for modules larger than 8 MB.
    const result = await WebAssembly.instantiate(module, imports);
    return result;
  }
}
