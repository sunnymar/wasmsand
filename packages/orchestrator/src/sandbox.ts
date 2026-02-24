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
import type { SecurityOptions, AuditEventHandler } from './security.js';
import { CancelledError } from './security.js';
import type { WorkerExecutor } from './execution/worker-executor.js';

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

/** Internal config for the Sandbox constructor. Not part of the public API. */
interface SandboxParts {
  vfs: VFS;
  runner: ShellRunner;
  timeoutMs: number;
  adapter: PlatformAdapter;
  wasmDir: string;
  shellWasmPath: string;
  mgr: ProcessManager;
  bridge?: NetworkBridge;
  networkPolicy?: NetworkPolicy;
  security?: SecurityOptions;
  workerExecutor?: WorkerExecutor;
}

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
  private sessionId: string;
  private auditHandler: AuditEventHandler | undefined;
  private workerExecutor: WorkerExecutor | null = null;

  private constructor(parts: SandboxParts) {
    this.vfs = parts.vfs;
    this.runner = parts.runner;
    this.timeoutMs = parts.timeoutMs;
    this.adapter = parts.adapter;
    this.wasmDir = parts.wasmDir;
    this.shellWasmPath = parts.shellWasmPath;
    this.mgr = parts.mgr;
    this.bridge = parts.bridge ?? null;
    this.networkPolicy = parts.networkPolicy;
    this.security = parts.security;
    this.sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.auditHandler = parts.security?.onAuditEvent;
    this.workerExecutor = parts.workerExecutor ?? null;
  }

  private audit(type: string, data?: Record<string, unknown>): void {
    if (!this.auditHandler) return;
    this.auditHandler({
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...data,
    });
  }

  static async create(options: SandboxOptions): Promise<Sandbox> {
    const adapter = options.adapter ?? await Sandbox.detectAdapter();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fsLimitBytes = options.fsLimitBytes ?? DEFAULT_FS_LIMIT;

    const vfs = new VFS({ fsLimitBytes, fileCount: options.security?.limits?.fileCount });
    const { gateway, bridge } = await Sandbox.createNetworkBridge(options.network);
    const mgr = new ProcessManager(vfs, adapter, bridge, options.security?.toolAllowlist);
    const tools = await Sandbox.registerTools(mgr, adapter, options.wasmDir);

    const shellWasmPath = options.shellWasmPath ?? `${options.wasmDir}/wasmsand-shell.wasm`;
    const runner = new ShellRunner(vfs, mgr, adapter, shellWasmPath, gateway);

    // Apply output limits from security options
    if (options.security?.limits) {
      runner.setOutputLimits(options.security.limits.stdoutBytes, options.security.limits.stderrBytes);
    }

    // Apply memory limit
    if (options.security?.limits?.memoryBytes) {
      runner.setMemoryLimit(options.security.limits.memoryBytes);
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

    // Create WorkerExecutor for hard-kill preemption when enabled.
    let workerExecutor: WorkerExecutor | undefined;
    if (options.security?.hardKill && adapter.supportsWorkerExecution) {
      const { WorkerExecutor: WE } = await import('./execution/worker-executor.js');
      const toolRegistry: [string, string][] = [];
      for (const [name, path] of tools) {
        toolRegistry.push([name, path]);
      }
      if (!tools.has('python3')) {
        toolRegistry.push(['python3', `${options.wasmDir}/python3.wasm`]);
      }
      workerExecutor = new WE({
        vfs,
        wasmDir: options.wasmDir,
        shellWasmPath,
        toolRegistry,
        stdoutBytes: options.security?.limits?.stdoutBytes,
        stderrBytes: options.security?.limits?.stderrBytes,
        toolAllowlist: options.security?.toolAllowlist,
        memoryBytes: options.security?.limits?.memoryBytes,
        bridgeSab: bridge?.getSab(),
        networkPolicy: options.network ? {
          allowedHosts: options.network.allowedHosts,
          blockedHosts: options.network.blockedHosts,
        } : undefined,
      });
    }

    const sb = new Sandbox({
      vfs, runner, timeoutMs, adapter,
      wasmDir: options.wasmDir, shellWasmPath,
      mgr, bridge, networkPolicy: options.network,
      security: options.security, workerExecutor,
    });
    sb.audit('sandbox.create');
    return sb;
  }

  private static async detectAdapter(): Promise<PlatformAdapter> {
    if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
      const { NodeAdapter } = await import('./platform/node-adapter.js');
      return new NodeAdapter();
    }
    const { BrowserAdapter } = await import('./platform/browser-adapter.js');
    return new BrowserAdapter();
  }

  private static async createNetworkBridge(
    policy: NetworkPolicy | undefined,
  ): Promise<{ gateway?: NetworkGateway; bridge?: NetworkBridge }> {
    if (!policy) return {};
    const gateway = new NetworkGateway(policy);
    const bridge = new NetworkBridge(gateway);
    await bridge.start();
    return { gateway, bridge };
  }

  private static async registerTools(
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    wasmDir: string,
  ): Promise<Map<string, string>> {
    const tools = await adapter.scanTools(wasmDir);
    for (const [name, path] of tools) {
      mgr.registerTool(name, path);
    }
    if (!tools.has('python3')) {
      mgr.registerTool('python3', `${wasmDir}/python3.wasm`);
    }
    return tools;
  }

  async run(command: string): Promise<RunResult> {
    this.assertAlive();

    // Check command size limit
    const commandLimit = this.security?.limits?.commandBytes ?? 65536;
    if (new TextEncoder().encode(command).byteLength > commandLimit) {
      this.audit('limit.exceeded', { subtype: 'command', command });
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'command too large\n',
        executionTimeMs: 0,
        errorClass: 'LIMIT_EXCEEDED',
      };
    }

    this.audit('command.start', { command });

    const effectiveTimeout = this.security?.limits?.timeoutMs ?? this.timeoutMs;
    const startTime = performance.now();

    let result: RunResult;

    if (this.workerExecutor) {
      // Worker-based execution (Node) — hard kill on timeout via worker.terminate()
      const workerResult = await this.workerExecutor.run(command, this.runner.getEnvMap(), effectiveTimeout);

      // Sync env changes from Worker back to main-thread runner
      if (workerResult.env) {
        this.runner.setEnvMap(new Map(workerResult.env));
      }

      result = workerResult;
    } else {
      // Fallback: in-process execution (browser, or hardKill=false)
      this.runner.resetCancel(effectiveTimeout);
      try {
        result = await this.runner.run(command);
      } catch (e) {
        if (e instanceof CancelledError) {
          const executionTimeMs = performance.now() - startTime;
          result = {
            exitCode: 124,
            stdout: '',
            stderr: `command ${e.reason.toLowerCase()}\n`,
            executionTimeMs,
            errorClass: e.reason,
          };
        } else {
          throw e;
        }
      }
    }

    const executionTimeMs = performance.now() - startTime;

    // Post-execution audit
    if (result.errorClass === 'TIMEOUT') {
      this.audit('command.timeout', { command, executionTimeMs });
    } else if (result.errorClass === 'CANCELLED') {
      this.audit('command.cancelled', { command, executionTimeMs });
    } else {
      if (result.truncated?.stdout) {
        this.audit('limit.exceeded', { subtype: 'stdout', command });
      }
      if (result.truncated?.stderr) {
        this.audit('limit.exceeded', { subtype: 'stderr', command });
      }
      if (result.stderr?.includes('not allowed by security policy')) {
        this.audit('capability.denied', { command, reason: result.stderr.trim() });
      }
      this.audit('command.complete', { command, exitCode: result.exitCode, executionTimeMs });
    }

    return result;
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
    const { gateway, bridge } = await Sandbox.createNetworkBridge(this.networkPolicy);
    const childMgr = new ProcessManager(childVfs, this.adapter, bridge, this.security?.toolAllowlist);
    const tools = await Sandbox.registerTools(childMgr, this.adapter, this.wasmDir);
    const childRunner = new ShellRunner(childVfs, childMgr, this.adapter, this.shellWasmPath, gateway);

    // Copy env
    const envMap = this.runner.getEnvMap();
    for (const [k, v] of envMap) {
      childRunner.setEnv(k, v);
    }

    // Create WorkerExecutor for the child if parent uses hard-kill
    let childWorkerExecutor: WorkerExecutor | undefined;
    if (this.security?.hardKill && this.adapter.supportsWorkerExecution) {
      const { WorkerExecutor: WE } = await import('./execution/worker-executor.js');
      const toolRegistry: [string, string][] = [];
      for (const [name, path] of tools) {
        toolRegistry.push([name, path]);
      }
      if (!tools.has('python3')) {
        toolRegistry.push(['python3', `${this.wasmDir}/python3.wasm`]);
      }
      childWorkerExecutor = new WE({
        vfs: childVfs,
        wasmDir: this.wasmDir,
        shellWasmPath: this.shellWasmPath,
        toolRegistry,
        stdoutBytes: this.security?.limits?.stdoutBytes,
        stderrBytes: this.security?.limits?.stderrBytes,
        toolAllowlist: this.security?.toolAllowlist,
        memoryBytes: this.security?.limits?.memoryBytes,
        bridgeSab: bridge?.getSab(),
        networkPolicy: this.networkPolicy ? {
          allowedHosts: this.networkPolicy.allowedHosts,
          blockedHosts: this.networkPolicy.blockedHosts,
        } : undefined,
      });
    }

    return new Sandbox({
      vfs: childVfs, runner: childRunner, timeoutMs: this.timeoutMs,
      adapter: this.adapter, wasmDir: this.wasmDir, shellWasmPath: this.shellWasmPath,
      mgr: childMgr, bridge, networkPolicy: this.networkPolicy,
      security: this.security, workerExecutor: childWorkerExecutor,
    });
  }

  /** Cancel the currently running command. */
  cancel(): void {
    if (this.workerExecutor) {
      this.workerExecutor.kill();
    } else {
      this.runner.cancel('CANCELLED');
      // Set deadline to now so Date.now() checks in fdWrite/fdRead fire immediately
      this.runner.setDeadlineNow();
      this.mgr.cancelCurrent();
    }
  }

  destroy(): void {
    this.audit('sandbox.destroy');
    this.destroyed = true;
    this.workerExecutor?.dispose();
    this.bridge?.dispose();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('Sandbox has been destroyed');
    }
  }
}
