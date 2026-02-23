/**
 * Sandbox: high-level facade wrapping VFS + ProcessManager + ShellRunner.
 *
 * Provides a simple API for creating an isolated sandbox, running shell
 * commands, and interacting with the in-memory filesystem.
 */

import { VFS } from './vfs/vfs.js';
import type { VfsOptions } from './vfs/vfs.js';
import { ProcessManager } from './process/manager.js';
import { ShellRunner } from './shell/shell-runner.js';
import type { RunResult } from './shell/shell-runner.js';
import type { PlatformAdapter } from './platform/adapter.js';
import type { DirEntry, StatResult } from './vfs/inode.js';
import { NetworkGateway } from './network/gateway.js';
import type { NetworkPolicy } from './network/gateway.js';
import { NetworkBridge } from './network/bridge.js';
import { SOCKET_SHIM_SOURCE, SITE_CUSTOMIZE_SOURCE } from './network/socket-shim.js';
import type { SecurityOptions } from './security.js';

export interface SandboxOptions {
  /** Directory (Node) or URL base (browser) containing .wasm files. */
  wasmDir: string;
  /** Platform adapter. Auto-detected if not provided (Node vs browser). */
  adapter?: PlatformAdapter;
  /** Per-command wall-clock timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max VFS size in bytes. Default 256MB. */
  fsLimitBytes?: number;
  /** Path to the shell parser wasm. Defaults to `${wasmDir}/wasmsand-shell.wasm`. */
  shellWasmPath?: string;
  /** Network policy for curl/wget builtins. If omitted, network access is disabled. */
  network?: NetworkPolicy;
  /** Security policy and limits. */
  security?: SecurityOptions;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FS_LIMIT = 256 * 1024 * 1024; // 256 MB

export class Sandbox {
  private vfs: VFS;
  private runner: ShellRunner;
  private timeoutMs: number;
  private destroyed = false;
  private adapter: PlatformAdapter;
  private wasmDir: string;
  private shellWasmPath: string;
  private mgr: ProcessManager;
  private envSnapshots: Map<string, Map<string, string>> = new Map();
  private bridge: NetworkBridge | null = null;
  private networkPolicy: NetworkPolicy | undefined;
  private security: SecurityOptions | undefined;

  private constructor(
    vfs: VFS,
    runner: ShellRunner,
    timeoutMs: number,
    adapter: PlatformAdapter,
    wasmDir: string,
    shellWasmPath: string,
    mgr: ProcessManager,
    bridge?: NetworkBridge,
    networkPolicy?: NetworkPolicy,
    security?: SecurityOptions,
  ) {
    this.vfs = vfs;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.adapter = adapter;
    this.wasmDir = wasmDir;
    this.shellWasmPath = shellWasmPath;
    this.mgr = mgr;
    this.bridge = bridge ?? null;
    this.networkPolicy = networkPolicy;
    this.security = security;
  }

  static async create(options: SandboxOptions): Promise<Sandbox> {
    const adapter = options.adapter ?? await Sandbox.detectAdapter();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fsLimitBytes = options.fsLimitBytes ?? DEFAULT_FS_LIMIT;

    const vfs = new VFS({ fsLimitBytes });
    const gateway = options.network ? new NetworkGateway(options.network) : undefined;

    // Create bridge for WASI socket access when network policy exists
    let bridge: NetworkBridge | undefined;
    if (gateway) {
      bridge = new NetworkBridge(gateway);
      await bridge.start();
    }

    const mgr = new ProcessManager(vfs, adapter, bridge);

    // Discover and register tools
    const tools = await adapter.scanTools(options.wasmDir);
    for (const [name, path] of tools) {
      mgr.registerTool(name, path);
    }

    // Register python3 if not already discovered
    if (!tools.has('python3')) {
      mgr.registerTool('python3', `${options.wasmDir}/python3.wasm`);
    }

    // Shell parser wasm
    const shellWasmPath = options.shellWasmPath ?? `${options.wasmDir}/wasmsand-shell.wasm`;
    const runner = new ShellRunner(vfs, mgr, adapter, shellWasmPath, gateway);

    // Apply output limits from security options
    if (options.security?.limits) {
      runner.setOutputLimits(options.security.limits.stdoutBytes, options.security.limits.stderrBytes);
    }

    // Bootstrap Python socket shim when networking is enabled
    if (bridge) {
      vfs.withWriteAccess(() => {
        vfs.mkdirp('/usr/lib/python');
        vfs.writeFile('/usr/lib/python/socket.py', new TextEncoder().encode(SOCKET_SHIM_SOURCE));
        // sitecustomize.py pre-loads our socket shim into sys.modules at interpreter
        // startup, bypassing RustPython's frozen socket module which would otherwise
        // take priority over PYTHONPATH files.
        vfs.writeFile('/usr/lib/python/sitecustomize.py', new TextEncoder().encode(SITE_CUSTOMIZE_SOURCE));
      });
      runner.setEnv('PYTHONPATH', '/usr/lib/python');
    }

    return new Sandbox(vfs, runner, timeoutMs, adapter, options.wasmDir, shellWasmPath, mgr, bridge, options.network, options.security);
  }

  private static async detectAdapter(): Promise<PlatformAdapter> {
    if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
      const { NodeAdapter } = await import('./platform/node-adapter.js');
      return new NodeAdapter();
    }
    const { BrowserAdapter } = await import('./platform/browser-adapter.js');
    return new BrowserAdapter();
  }

  async run(command: string): Promise<RunResult> {
    this.assertAlive();
    const effectiveTimeout = this.security?.limits?.timeoutMs ?? this.timeoutMs;
    const timer = new Promise<RunResult>((resolve) => {
      setTimeout(() => resolve({
        exitCode: 124,
        stdout: '',
        stderr: 'command timed out\n',
        executionTimeMs: effectiveTimeout,
        errorClass: 'TIMEOUT',
      }), effectiveTimeout);
    });
    return Promise.race([this.runner.run(command), timer]);
  }

  readFile(path: string): Uint8Array {
    this.assertAlive();
    return this.vfs.readFile(path);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.assertAlive();
    this.vfs.writeFile(path, data);
  }

  readDir(path: string): DirEntry[] {
    this.assertAlive();
    return this.vfs.readdir(path);
  }

  mkdir(path: string): void {
    this.assertAlive();
    this.vfs.mkdir(path);
  }

  stat(path: string): StatResult {
    this.assertAlive();
    return this.vfs.stat(path);
  }

  rm(path: string): void {
    this.assertAlive();
    this.vfs.unlink(path);
  }

  setEnv(name: string, value: string): void {
    this.assertAlive();
    this.runner.setEnv(name, value);
  }

  getEnv(name: string): string | undefined {
    this.assertAlive();
    return this.runner.getEnv(name);
  }

  snapshot(): string {
    this.assertAlive();
    const id = this.vfs.snapshot();
    this.envSnapshots.set(id, this.runner.getEnvMap());
    return id;
  }

  restore(id: string): void {
    this.assertAlive();
    this.vfs.restore(id);
    const envSnap = this.envSnapshots.get(id);
    if (envSnap) {
      this.runner.setEnvMap(envSnap);
    }
  }

  async fork(): Promise<Sandbox> {
    this.assertAlive();
    const childVfs = this.vfs.cowClone();

    // Create a new bridge for the forked sandbox if the parent has network policy
    let childBridge: NetworkBridge | undefined;
    let childGateway: NetworkGateway | undefined;
    if (this.networkPolicy) {
      childGateway = new NetworkGateway(this.networkPolicy);
      childBridge = new NetworkBridge(childGateway);
      await childBridge.start();
    }

    const childMgr = new ProcessManager(childVfs, this.adapter, childBridge);

    // Re-register tools from the same wasmDir
    const tools = await this.adapter.scanTools(this.wasmDir);
    for (const [name, path] of tools) {
      childMgr.registerTool(name, path);
    }
    if (!tools.has('python3')) {
      childMgr.registerTool('python3', `${this.wasmDir}/python3.wasm`);
    }

    const childRunner = new ShellRunner(childVfs, childMgr, this.adapter, this.shellWasmPath, childGateway);

    // Copy env
    const envMap = this.runner.getEnvMap();
    for (const [k, v] of envMap) {
      childRunner.setEnv(k, v);
    }

    return new Sandbox(
      childVfs, childRunner, this.timeoutMs,
      this.adapter, this.wasmDir, this.shellWasmPath,
      childMgr, childBridge, this.networkPolicy, this.security,
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.bridge?.dispose();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('Sandbox has been destroyed');
    }
  }
}
