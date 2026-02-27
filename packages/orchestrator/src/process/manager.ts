/**
 * Process manager for spawning and running Wasm binaries in the sandbox.
 *
 * Handles command resolution, module caching, WASI host setup, and
 * execution lifecycle. Each spawn() call creates an isolated WasiHost
 * with its own file descriptor table, args, and environment.
 */

import type { PlatformAdapter } from '../platform/adapter.js';
import type { VfsLike } from '../vfs/vfs-like.js';
import { WasiHost } from '../wasi/wasi-host.js';
import type { NetworkBridgeLike } from '../network/bridge.js';
import { createPythonImports } from '../host-imports/python-imports.js';

import type { SpawnOptions, SpawnResult } from './process.js';

export class ProcessManager {
  private vfs: VfsLike;
  private adapter: PlatformAdapter;
  private registry: Map<string, string> = new Map();
  private moduleCache: Map<string, WebAssembly.Module> = new Map();
  private networkBridge: NetworkBridgeLike | null;
  private currentHost: WasiHost | null = null;
  private toolAllowlist: Set<string> | null = null;
  private extensionHandler: ((cmd: Record<string, unknown>) => Record<string, unknown>) | null = null;

  constructor(vfs: VfsLike, adapter: PlatformAdapter, networkBridge?: NetworkBridgeLike, toolAllowlist?: string[]) {
    this.vfs = vfs;
    this.adapter = adapter;
    this.networkBridge = networkBridge ?? null;
    this.toolAllowlist = toolAllowlist ? new Set(toolAllowlist) : null;
  }

  /** Register a tool name to a .wasm file path. */
  registerTool(name: string, wasmPath: string): void {
    this.registry.set(name, wasmPath);
  }

  /** Return the names of all registered tools. */
  getRegisteredTools(): string[] {
    return Array.from(this.registry.keys());
  }

  /** Cancel the currently running WASI process, if any. */
  cancelCurrent(): void {
    this.currentHost?.cancelExecution();
  }

  /** Set the extension handler for Python package → host extension bridge. */
  setExtensionHandler(handler: (cmd: Record<string, unknown>) => Record<string, unknown>): void {
    this.extensionHandler = handler;
  }

  /** Check if a tool name is registered. */
  hasTool(name: string): boolean {
    return this.registry.has(name);
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
    if (this.toolAllowlist && !this.toolAllowlist.has(command)) {
      return {
        exitCode: 126,
        stdout: '',
        stderr: `${command}: tool not allowed by security policy\n`,
        executionTimeMs: 0,
      };
    }
    const wasmPath = this.resolveTool(command);
    const module = await this.loadModule(wasmPath);

    // Collect stdin data: prefer explicit stdinData, otherwise drain the stdin pipe
    let stdinData: Uint8Array | undefined = opts.stdinData;
    if (stdinData === undefined && opts.stdin !== undefined) {
      stdinData = drainReadEnd(opts.stdin);
    }

    const host = new WasiHost({
      vfs: this.vfs,
      args: [command, ...opts.args],
      env: opts.env,
      preopens: { '/': '/' },
      stdin: stdinData,
      stdoutLimit: opts.stdoutLimit,
      stderrLimit: opts.stderrLimit,
      deadlineMs: opts.deadlineMs,
    });

    // If memoryBytes is set, inject a bounded memory into the import object
    const imports = host.getImports() as WebAssembly.Imports & Record<string, WebAssembly.ModuleImports>;
    if (opts.memoryBytes !== undefined) {
      const maxPages = Math.ceil(opts.memoryBytes / 65536);
      const moduleImports = WebAssembly.Module.imports(module);
      for (const imp of moduleImports) {
        if (imp.kind === 'memory') {
          const mem = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
          if (!imports[imp.module]) imports[imp.module] = {};
          imports[imp.module][imp.name] = mem;
        }
      }
    }

    // If the module imports from the `codepod` namespace, inject Python host
    // imports using a memory proxy (memory comes from instance exports, which
    // aren't available until after instantiation).
    const moduleImportDescs = WebAssembly.Module.imports(module);
    const needsCodepod = moduleImportDescs.some(imp => imp.module === 'codepod');

    let setMemoryRef: ((mem: WebAssembly.Memory) => void) | null = null;

    if (needsCodepod) {
      let memRef: WebAssembly.Memory | null = null;
      setMemoryRef = (mem: WebAssembly.Memory) => { memRef = mem; };

      const memoryProxy = new Proxy({} as WebAssembly.Memory, {
        get(_target, prop) {
          if (!memRef) throw new Error('memory not initialized');
          const val = (memRef as unknown as Record<string | symbol, unknown>)[prop];
          return typeof val === 'function' ? (val as Function).bind(memRef) : val;
        },
      });

      imports.codepod = createPythonImports({
        memory: memoryProxy,
        networkBridge: this.networkBridge ?? undefined,
        extensionHandler: this.extensionHandler ?? undefined,
      });
    }

    const instance = await this.adapter.instantiate(module, imports);

    // Wire up the real memory reference for the codepod import proxy
    if (setMemoryRef) {
      setMemoryRef(instance.exports.memory as WebAssembly.Memory);
    }

    // Check exported memory against limit
    if (opts.memoryBytes !== undefined) {
      const mem = instance.exports.memory as WebAssembly.Memory | undefined;
      if (mem) {
        // Check if the module defined its own unbounded memory (no import).
        // If we injected a bounded memory via imports, that's fine. But if
        // the module defines memory internally, it bypasses our limit.
        const moduleImports = WebAssembly.Module.imports(module);
        const hasMemoryImport = moduleImports.some(imp => imp.kind === 'memory');
        if (!hasMemoryImport) {
          // Module defined its own memory — check if it has a maximum.
          // We can't inspect the max directly, but we can reject if the
          // module exported memory without importing our bounded one.
          return {
            exitCode: 1,
            stdout: '',
            stderr: `module defines its own memory, bypassing sandbox memory limit\n`,
            executionTimeMs: 0,
          };
        }
        if (mem.buffer.byteLength > opts.memoryBytes) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: `memory limit exceeded: ${mem.buffer.byteLength} > ${opts.memoryBytes}\n`,
            executionTimeMs: 0,
          };
        }
      }
    }

    this.currentHost = host;
    const startTime = performance.now();
    const exitCode = host.start(instance);
    const executionTimeMs = performance.now() - startTime;
    this.currentHost = null;

    const stdoutTruncated = host.isStdoutTruncated();
    const stderrTruncated = host.isStderrTruncated();

    return {
      exitCode,
      stdout: host.getStdout(),
      stderr: host.getStderr(),
      executionTimeMs,
      truncated: (stdoutTruncated || stderrTruncated) ? { stdout: stdoutTruncated, stderr: stderrTruncated } : undefined,
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

/** Drain all available bytes from a pipe read end into a single Uint8Array. */
function drainReadEnd(readEnd: { read(buf: Uint8Array): number }): Uint8Array {
  const chunks: Uint8Array[] = [];
  const tmp = new Uint8Array(4096);

  for (;;) {
    const n = readEnd.read(tmp);
    if (n === 0) {
      break;
    }
    chunks.push(tmp.slice(0, n));
  }

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0];
  }

  let totalLen = 0;
  for (const chunk of chunks) {
    totalLen += chunk.byteLength;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
