/**
 * Process manager for spawning and running Wasm binaries in the sandbox.
 *
 * Handles command resolution, module caching, WASI host setup, and
 * execution lifecycle. Each spawn() call creates an isolated WasiHost
 * with its own file descriptor table, args, and environment.
 */

import type { PlatformAdapter } from '../platform/adapter.js';
import type { VfsLike } from '../vfs/vfs-like.js';
import { S_TOOL } from '../vfs/inode.js';
import { WasiHost } from '../wasi/wasi-host.js';
import type { NetworkBridgeLike } from '../network/bridge.js';
import { createKernelImports } from '../host-imports/kernel-imports.js';

import type { SpawnOptions, SpawnResult } from './process.js';
import type { ExtensionHandler } from '../extension/types.js';
import { NativeModuleRegistry } from './native-modules.js';

export class ProcessManager {
  private vfs: VfsLike;
  private adapter: PlatformAdapter;
  private registry: Map<string, string> = new Map();
  private hostCommands: Map<string, { handler: ExtensionHandler; description?: string }> = new Map();
  private moduleCache: Map<string, WebAssembly.Module> = new Map();
  private networkBridge: NetworkBridgeLike | null;
  private currentHost: WasiHost | null = null;
  private toolAllowlist: Set<string> | null = null;
  private extensionHandler: ((cmd: Record<string, unknown>) => Record<string, unknown>) | null = null;

  /** Registry for dynamically loaded native Python module WASMs. */
  readonly nativeModules: NativeModuleRegistry;

  constructor(vfs: VfsLike, adapter: PlatformAdapter, networkBridge?: NetworkBridgeLike, toolAllowlist?: string[]) {
    this.vfs = vfs;
    this.adapter = adapter;
    this.networkBridge = networkBridge ?? null;
    this.toolAllowlist = toolAllowlist ? new Set(toolAllowlist) : null;
    this.nativeModules = new NativeModuleRegistry();
  }

  /** Register a tool name to a .wasm file path.
   *  Also creates an executable tool file at /usr/bin/<name> so that
   *  symlinks (e.g. `ln -s python3 /usr/bin/python`) resolve naturally. */
  /** Register a native Python module WASM (loaded for _codepod.native_call bridge). */
  async registerNativeModule(name: string, wasmBytes: Uint8Array): Promise<void> {
    await this.nativeModules.loadModule(name, wasmBytes);
  }

  registerTool(name: string, wasmPath: string): void {
    this.registry.set(name, wasmPath);
    // Create tool stub in /usr/bin — content is the wasm path, marked with S_TOOL.
    // S_TOOL is a high bit that chmod cannot set or clear, so sandbox users
    // cannot forge tool files. /usr/bin is 0o555 so writes are also blocked.
    try {
      this.vfs.withWriteAccess(() => {
        this.vfs.writeFile(
          `/usr/bin/${name}`,
          new TextEncoder().encode(wasmPath),
        );
        this.vfs.chmod(`/usr/bin/${name}`, S_TOOL | 0o555);
      });
    } catch {
      // VFS may not have /usr/bin yet (e.g. VfsProxy in worker) — non-fatal
    }
  }

  /**
   * Register a multicall binary — one wasm that ships many applets,
   * dispatched by argv[0] (BusyBox is the canonical example).
   *
   * Does three things:
   *   1. Registers the multicall name itself (`registerTool('busybox',
   *      busyboxPath)`) so `busybox <applet>` works.
   *   2. Points each applet name at the same wasm in the registry —
   *      crucially, this OVERRIDES any prior single-binary registration
   *      (e.g. our Rust `grep.wasm`) so the shell resolves `grep` to
   *      busybox.wasm from now on.  The Rust standalones still exist
   *      on disk but become inert — they can be stripped in a follow-
   *      up commit once we're confident in busybox parity.
   *   3. Replaces /usr/bin/<applet> tool-stub files with symlinks to
   *      /usr/bin/<name> so commands like `/usr/bin/grep foo` (absolute
   *      path) follow the symlink and the kernel-side spawn populates
   *      argv[0] with "grep" — the multicall dispatcher in busybox
   *      reads argv[0] to pick the right applet.
   *
   * Behaves identically to `busybox --install -s` from the guest's
   * perspective, but happens at sandbox creation so users don't have
   * to run the install step themselves.
   */
  registerMulticallTool(name: string, wasmPath: string, applets: string[]): void {
    this.registerTool(name, wasmPath);

    for (const applet of applets) {
      this.registry.set(applet, wasmPath);
    }

    // VfsProxy in worker mode doesn't expose withWriteAccess / symlink
    // yet; feature-detect rather than try/catch so genuine failures
    // mid-loop (e.g. a real symlink error on applet #5) surface
    // instead of silently leaving applets #6–N un-symlinked.  Without
    // VFS write access the registry overrides above still resolve
    // correctly via resolveTool — symlinks are a UX nicety, not load-
    // bearing for dispatch.
    const vfsLike = this.vfs as { withWriteAccess?: unknown };
    if (typeof vfsLike.withWriteAccess !== 'function') return;
    this.vfs.withWriteAccess(() => {
      for (const applet of applets) {
        const appletPath = `/usr/bin/${applet}`;
        // Replace any prior tool stub (registerTool may have written
        // one earlier in registerTools' scan).  Failing to unlink is
        // fine — the path may not exist yet.
        try { this.vfs.unlink(appletPath); } catch { /* ok */ }
        this.vfs.symlink(`/usr/bin/${name}`, appletPath);
      }
    });
  }

  /** Register and preload a tool from VFS — for runtime-installed packages. */
  async registerAndLoadTool(name: string, wasmPath: string): Promise<void> {
    this.registerTool(name, wasmPath);
    // Load WASM bytes from VFS and compile directly (not from host filesystem)
    const wasmBytes = this.vfs.readFile(wasmPath);
    const module = await WebAssembly.compile(wasmBytes as BufferSource);
    this.moduleCache.set(wasmPath, module);
  }

  /** Register a host command (TypeScript handler) that looks like an executable.
   *  Also creates a tool stub in /usr/bin so the shell can discover it. */
  registerHostCommand(name: string, handler: ExtensionHandler, description?: string): void {
    this.hostCommands.set(name, { handler, description });
    // Create tool stub in /usr/bin like WASM tools
    try {
      this.vfs.withWriteAccess(() => {
        this.vfs.writeFile(
          `/usr/bin/${name}`,
          new TextEncoder().encode(`host:${name}`),
        );
        this.vfs.chmod(`/usr/bin/${name}`, S_TOOL | 0o555);
      });
    } catch {
      // VFS may not have /usr/bin yet — non-fatal
    }
  }

  /** Get a host command entry by name, or undefined if not registered. */
  getHostCommand(name: string): { handler: ExtensionHandler; description?: string } | undefined {
    return this.hostCommands.get(name);
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

  /** Check if a tool name is registered (WASM tool or host command). */
  hasTool(name: string): boolean {
    return this.registry.has(name) || this.hostCommands.has(name);
  }

  /** Check if a tool is allowed by the security policy. */
  isToolAllowed(name: string): boolean {
    if (!this.toolAllowlist) return true;
    return this.toolAllowlist.has(name);
  }

  /** Resolve a tool name to its .wasm path, or throw if not registered.
   *  Falls back to VFS PATH lookup so that symlinks work as aliases
   *  (e.g. /usr/bin/python → python3 resolves to the python3 wasm path). */
  resolveTool(name: string): string {
    const direct = this.registry.get(name);
    if (direct !== undefined) return direct;

    // VFS PATH fallback: check /usr/bin/<name> (stat follows symlinks).
    // Only files with the S_TOOL flag are valid tool stubs — this flag
    // cannot be set via chmod, so sandbox users cannot forge tool files.
    for (const dir of ['/usr/bin', '/bin']) {
      try {
        const filePath = `${dir}/${name}`;
        const st = this.vfs.stat(filePath); // follows symlinks
        if (!(st.permissions & S_TOOL)) continue; // not a tool file
        // Read the resolved file's content — it contains the wasm path
        const content = new TextDecoder().decode(this.vfs.readFile(filePath));
        if (content && this.moduleCache.has(content)) return content;
        // Also try registry lookup by content (wasm path may match)
        for (const [, wasmPath] of this.registry) {
          if (wasmPath === content) return wasmPath;
        }
      } catch {
        // Not found in this dir, continue
      }
    }

    throw new Error(`Tool not found: ${name}`);
  }

  /** Return the VFS instance for external use (e.g. spawnAsyncProcess). */
  getVfs(): VfsLike {
    return this.vfs;
  }

  /** Return the platform adapter for external use (e.g. spawnAsyncProcess). */
  getAdapter(): PlatformAdapter {
    return this.adapter;
  }

  /**
   * Resolve a tool name to a pre-loaded WebAssembly.Module, or null if not
   * registered or not yet loaded.
   */
  getModule(prog: string): WebAssembly.Module | null {
    let wasmPath: string;
    try {
      wasmPath = this.resolveTool(prog);
    } catch {
      return null;
    }
    return this.moduleCache.get(wasmPath) ?? null;
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

      imports.codepod = createKernelImports({
        memory: memoryProxy,
        wasiHost: host,
        networkBridge: this.networkBridge ?? undefined,
        extensionHandler: this.extensionHandler ?? undefined,
        nativeModules: this.nativeModules,
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

  /**
   * Pre-load all registered tool modules into the cache so they can be
   * used synchronously by spawnSync().
   */
  async preloadModules(): Promise<void> {
    const paths = new Set(this.registry.values());
    await Promise.all(Array.from(paths).map(p => this.loadModule(p)));
  }

  /**
   * Synchronous spawn for the rust-wasm backend (host_spawn callback).
   * Requires that the module has been pre-loaded via preloadModules().
   * Falls back to returning an error if the module is not cached.
   */
  spawnSync(
    command: string,
    args: string[],
    env: Record<string, string>,
    stdin: Uint8Array,
    cwd: string,
    opts?: { deadlineMs?: number; stdoutLimit?: number; stderrLimit?: number; memoryBytes?: number },
  ): { exit_code: number; stdout: string; stderr: string } {
    if (this.toolAllowlist && !this.toolAllowlist.has(command)) {
      return {
        exit_code: 126,
        stdout: '',
        stderr: `${command}: tool not allowed by security policy\n`,
      };
    }

    // Check host commands first (TS handlers)
    const hostCmd = this.hostCommands.get(command);
    if (hostCmd) {
      // Host commands are async but spawnSync needs sync results.
      // This path is used by the Worker extension proxy which is already sync.
      // For now, return not-found so the caller can try other paths.
      // Host commands are primarily handled by spawnAsyncProcess.
      return { exit_code: 127, stdout: '', stderr: `${command}: host command not available in sync mode\n` };
    }

    let wasmPath: string;
    try {
      wasmPath = this.resolveTool(command);
    } catch {
      return { exit_code: 127, stdout: '', stderr: `${command}: not found\n` };
    }

    const module = this.moduleCache.get(wasmPath);
    if (!module) {
      return { exit_code: 127, stdout: '', stderr: `${command}: module not loaded\n` };
    }

    const host = new WasiHost({
      vfs: this.vfs,
      args: [command, ...args],
      env,
      preopens: { '/': '/' },
      stdin,
      stdoutLimit: opts?.stdoutLimit,
      stderrLimit: opts?.stderrLimit,
      deadlineMs: opts?.deadlineMs,
    });

    const imports = host.getImports() as WebAssembly.Imports & Record<string, WebAssembly.ModuleImports>;

    // If memoryBytes is set, inject a bounded memory into the import object
    if (opts?.memoryBytes !== undefined) {
      const maxPages = Math.ceil(opts.memoryBytes / 65536);
      const moduleImportDescs2 = WebAssembly.Module.imports(module);
      for (const imp of moduleImportDescs2) {
        if (imp.kind === 'memory') {
          const mem = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
          if (!imports[imp.module]) imports[imp.module] = {};
          imports[imp.module][imp.name] = mem;
        }
      }
    }

    // If the module imports from the `codepod` namespace, inject Python host
    // imports using a memory proxy.
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

      imports.codepod = createKernelImports({
        memory: memoryProxy,
        wasiHost: host,
        networkBridge: this.networkBridge ?? undefined,
        extensionHandler: this.extensionHandler ?? undefined,
        nativeModules: this.nativeModules,
      });
    }

    // Synchronous instantiation (works because Module is already compiled)
    let instance: WebAssembly.Instance;
    try {
      instance = new WebAssembly.Instance(module, imports);
    } catch (e: unknown) {
      if (opts?.memoryBytes !== undefined && e instanceof Error && /memory/i.test(e.message)) {
        return { exit_code: 1, stdout: '', stderr: `memory limit exceeded\n` };
      }
      // Catch >8MB sync instantiation errors (V8 main-thread limitation) and
      // other instantiation failures — return an error result instead of crashing.
      if (e instanceof Error) {
        return { exit_code: 1, stdout: '', stderr: `${command}: ${e.message}\n` };
      }
      throw e;
    }

    // Check exported memory against limit
    if (opts?.memoryBytes !== undefined) {
      const mem = instance.exports.memory as WebAssembly.Memory | undefined;
      if (mem) {
        const moduleImports3 = WebAssembly.Module.imports(module);
        const hasMemoryImport = moduleImports3.some(imp => imp.kind === 'memory');
        if (!hasMemoryImport) {
          return { exit_code: 1, stdout: '', stderr: `memory limit exceeded\n` };
        }
        if (mem.buffer.byteLength > opts.memoryBytes) {
          return { exit_code: 1, stdout: '', stderr: `memory limit exceeded\n` };
        }
      }
    }

    if (setMemoryRef) {
      setMemoryRef(instance.exports.memory as WebAssembly.Memory);
    }

    this.currentHost = host;
    const exitCode = host.start(instance);
    this.currentHost = null;

    const stdoutTruncated = host.isStdoutTruncated();
    const stderrTruncated = host.isStderrTruncated();

    return {
      exit_code: exitCode,
      stdout: host.getStdout(),
      stderr: host.getStderr(),
      ...(stdoutTruncated || stderrTruncated ? {
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
      } : {}),
    };
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
