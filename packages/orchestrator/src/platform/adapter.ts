/**
 * Platform adapter interface for loading and instantiating WebAssembly modules.
 *
 * Abstracts the differences between Node.js (filesystem) and browser (fetch)
 * environments so the orchestrator can run in both without platform checks.
 */

export interface PlatformAdapter {
  /** Load a .wasm module from a path (Node: filesystem) or URL (Browser: fetch). */
  loadModule(pathOrUrl: string): Promise<WebAssembly.Module>;

  /** Instantiate a module with the given import object. */
  instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance>;
}
