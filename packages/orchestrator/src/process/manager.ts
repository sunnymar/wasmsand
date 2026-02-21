/**
 * Process manager for spawning and running Wasm binaries in the sandbox.
 *
 * Handles command resolution, module caching, WASI host setup, and
 * execution lifecycle. Each spawn() call creates an isolated WasiHost
 * with its own file descriptor table, args, and environment.
 */

import type { PlatformAdapter } from '../platform/adapter.js';
import type { VFS } from '../vfs/vfs.js';
import { WasiHost } from '../wasi/wasi-host.js';

import type { SpawnOptions, SpawnResult } from './process.js';

export class ProcessManager {
  private vfs: VFS;
  private adapter: PlatformAdapter;
  private registry: Map<string, string> = new Map();
  private moduleCache: Map<string, WebAssembly.Module> = new Map();

  constructor(vfs: VFS, adapter: PlatformAdapter) {
    this.vfs = vfs;
    this.adapter = adapter;
  }

  /** Register a tool name to a .wasm file path. */
  registerTool(name: string, wasmPath: string): void {
    this.registry.set(name, wasmPath);
  }

  /** Resolve a tool name to its .wasm path, or throw if not registered. */
  resolveTool(name: string): string {
    const path = this.registry.get(name);
    if (path === undefined) {
      throw new Error(`Tool not found: ${name}`);
    }
    return path;
  }

  /**
   * Spawn a Wasm process: resolve the command, load (or reuse) the
   * compiled module, wire up a fresh WasiHost, run _start, and
   * return the captured output.
   */
  async spawn(command: string, opts: SpawnOptions): Promise<SpawnResult> {
    const wasmPath = this.resolveTool(command);
    const module = await this.loadModule(wasmPath);

    const host = new WasiHost({
      vfs: this.vfs,
      args: [command, ...opts.args],
      env: opts.env,
      preopens: { '/': '/' },
    });

    const instance = await this.adapter.instantiate(module, host.getImports());

    const startTime = performance.now();
    const exitCode = host.start(instance);
    const executionTimeMs = performance.now() - startTime;

    return {
      exitCode,
      stdout: host.getStdout(),
      stderr: host.getStderr(),
      executionTimeMs,
    };
  }

  /**
   * Load a .wasm module, returning a cached copy when available.
   * The first load for a given path compiles via the platform adapter;
   * subsequent loads reuse the compiled Module.
   */
  private async loadModule(wasmPath: string): Promise<WebAssembly.Module> {
    const cached = this.moduleCache.get(wasmPath);
    if (cached !== undefined) {
      return cached;
    }

    const module = await this.adapter.loadModule(wasmPath);
    this.moduleCache.set(wasmPath, module);
    return module;
  }
}
