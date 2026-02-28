/**
 * Sandbox: high-level facade wrapping VFS + ProcessManager + ShellInstance.
 *
 * Provides a simple API for creating an isolated sandbox, running shell
 * commands, and interacting with the in-memory filesystem.
 */

import { VFS } from './vfs/vfs.js';
import type { VfsOptions } from './vfs/vfs.js';
import { ProcessManager } from './process/manager.js';
import { ShellInstance } from './shell/shell-instance.js';
import type { ShellLike } from './shell/shell-like.js';
import type { RunResult } from './shell/shell-types.js';
import type { HistoryEntry } from './shell/history.js';
import type { PlatformAdapter } from './platform/adapter.js';
import type { DirEntry, StatResult } from './vfs/inode.js';
import { NetworkGateway } from './network/gateway.js';
import type { NetworkPolicy } from './network/gateway.js';
import { NetworkBridge } from './network/bridge.js';
import { SOCKET_SHIM_SOURCE, SITE_CUSTOMIZE_SOURCE } from './network/socket-shim.js';
import type { SecurityOptions, AuditEventHandler } from './security.js';
import { CancelledError } from './security.js';
import type { WorkerExecutor } from './execution/worker-executor.js';
import { PackageManager } from './pkg/manager.js';
import { exportState as serializerExportState, importState as serializerImportState } from './persistence/serializer.js';
import type { PersistenceOptions } from './persistence/types.js';
import { PersistenceManager } from './persistence/manager.js';
import { HostMount } from './vfs/host-mount.js';
import type { VirtualProvider } from './vfs/provider.js';
import { ExtensionRegistry } from './extension/registry.js';
import type { ExtensionConfig } from './extension/types.js';
import { CODEPOD_EXT_SOURCE } from './extension/codepod-ext-shim.js';
import { PackageRegistry } from './packages/registry.js';

/** Describes a set of host-provided files to mount into the VFS. */
export interface MountConfig {
  /** Absolute mount path (e.g. '/mnt/tools'). */
  path: string;
  /** Flat map of relative subpaths to file contents. */
  files: Record<string, Uint8Array>;
  /** Allow writes to this mount. Default false. */
  writable?: boolean;
}

export interface SandboxOptions {
  /** Directory (Node) or URL base (browser) containing .wasm files. */
  wasmDir: string;
  /** Platform adapter. Auto-detected if not provided (Node vs browser). */
  adapter?: PlatformAdapter;
  /** Per-command wall-clock timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max VFS size in bytes. Default 256MB. */
  fsLimitBytes?: number;
  /** Path to the shell-exec WASM binary. Defaults to `${wasmDir}/codepod-shell-exec.wasm`. */
  shellExecWasmPath?: string;
  /** Network policy for curl/wget builtins. If omitted, network access is disabled. */
  network?: NetworkPolicy;
  /** Security policy and limits. */
  security?: SecurityOptions;
  /** Persistence configuration. Default mode is 'ephemeral' (no persistence). */
  persistence?: PersistenceOptions;
  /** Host-provided file mounts. Processed before shell initialization. */
  mounts?: MountConfig[];
  /** Directories to include in PYTHONPATH (in addition to /usr/lib/python). */
  pythonPath?: string[];
  /** Host-provided extensions (custom commands and/or Python packages). */
  extensions?: ExtensionConfig[];
  /** Sandbox-native packages to install from PackageRegistry (e.g. ['requests', 'pandas']). */
  packages?: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FS_LIMIT = 256 * 1024 * 1024; // 256 MB

/** Internal config for the Sandbox constructor. Not part of the public API. */
interface SandboxParts {
  vfs: VFS;
  runner: ShellLike;
  timeoutMs: number;
  adapter: PlatformAdapter;
  wasmDir: string;
  shellExecWasmPath: string;
  mgr: ProcessManager;
  bridge?: NetworkBridge;
  networkPolicy?: NetworkPolicy;
  security?: SecurityOptions;
  workerExecutor?: WorkerExecutor;
  extensionRegistry?: ExtensionRegistry;
}

export class Sandbox {
  private vfs: VFS;
  private runner: ShellLike;
  private timeoutMs: number;
  private destroyed = false;
  private adapter: PlatformAdapter;
  private wasmDir: string;
  private shellExecWasmPath: string;
  private mgr: ProcessManager;
  private envSnapshots: Map<string, Map<string, string>> = new Map();
  private bridge: NetworkBridge | null = null;
  private networkPolicy: NetworkPolicy | undefined;
  private security: SecurityOptions | undefined;
  private sessionId: string;
  private auditHandler: AuditEventHandler | undefined;
  private workerExecutor: WorkerExecutor | null = null;
  private persistenceManager: PersistenceManager | null = null;
  private extensionRegistry: ExtensionRegistry | null = null;

  private constructor(parts: SandboxParts) {
    this.vfs = parts.vfs;
    this.runner = parts.runner;
    this.timeoutMs = parts.timeoutMs;
    this.adapter = parts.adapter;
    this.wasmDir = parts.wasmDir;
    this.shellExecWasmPath = parts.shellExecWasmPath;
    this.mgr = parts.mgr;
    this.bridge = parts.bridge ?? null;
    this.networkPolicy = parts.networkPolicy;
    this.security = parts.security;
    this.sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.auditHandler = parts.security?.onAuditEvent;
    this.workerExecutor = parts.workerExecutor ?? null;
    this.extensionRegistry = parts.extensionRegistry ?? null;
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

    const vfs = new VFS({
      fsLimitBytes,
      fileCount: options.security?.limits?.fileCount,
      // Allow writes to system paths needed by virtual commands (pip, pkg)
      writablePaths: ['/home/user', '/tmp', '/usr/lib/python', '/etc/codepod', '/usr/share/pkg'],
    });
    const { gateway, bridge } = await Sandbox.createNetworkBridge(options.network);
    const mgr = new ProcessManager(vfs, adapter, bridge, options.security?.toolAllowlist);
    const tools = await Sandbox.registerTools(mgr, adapter, options.wasmDir);

    // Build extension registry
    const extensionRegistry = new ExtensionRegistry();
    if (options.extensions) {
      for (const ext of options.extensions) extensionRegistry.register(ext);
    }

    // Process host mounts before shell so files are available immediately
    if (options.mounts) {
      for (const mc of options.mounts) {
        const provider = new HostMount(mc.files, { writable: mc.writable });
        vfs.mount(mc.path, provider);
      }
    }

    const shellExecWasmPath = options.shellExecWasmPath ?? `${options.wasmDir}/codepod-shell-exec.wasm`;

    // Pre-load all tool modules so spawnSync can use them synchronously
    await mgr.preloadModules();

    // Use a mutable ref so the syncSpawn closure can access the ShellInstance's deadline
    let shellInstanceRef: ShellInstance | null = null;
    const secLimits = options.security?.limits;

    const runner = await ShellInstance.create(vfs, mgr, adapter, shellExecWasmPath, {
      syncSpawn: (cmd, args, env, stdin, cwd) =>
        mgr.spawnSync(cmd, args, env, stdin, cwd, {
          deadlineMs: shellInstanceRef?.getDeadlineMs(),
          memoryBytes: secLimits?.memoryBytes,
        }),
      networkBridge: bridge,
      extensionRegistry,
      toolAllowlist: options.security?.toolAllowlist,
    });
    shellInstanceRef = runner;

    // Wire output limits
    if (secLimits) {
      runner.setOutputLimits(secLimits.stdoutBytes, secLimits.stderrBytes);
    }

    // Install sandbox-native package files into VFS
    if (options.packages && options.packages.length > 0) {
      const pkgRegistry = new PackageRegistry();
      const toInstall = new Set<string>();
      for (const name of options.packages) {
        for (const dep of pkgRegistry.resolveDeps(name)) {
          toInstall.add(dep);
        }
      }
      vfs.withWriteAccess(() => {
        for (const name of toInstall) {
          const meta = pkgRegistry.get(name);
          if (!meta) continue;
          for (const [relPath, content] of Object.entries(meta.pythonFiles)) {
            const fullPath = `/usr/lib/python/${relPath}`;
            const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
            vfs.mkdirp(dir);
            vfs.writeFile(fullPath, new TextEncoder().encode(content));
          }
        }
      });
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
    }

    // Install extension Python package files in VFS
    if (extensionRegistry.getPackageNames().length > 0) {
      vfs.withWriteAccess(() => {
        vfs.mkdirp('/usr/lib/python');
        vfs.writeFile('/usr/lib/python/codepod_ext.py',
          new TextEncoder().encode(CODEPOD_EXT_SOURCE));
        for (const name of extensionRegistry.getPackageNames()) {
          const ext = extensionRegistry.get(name)!;
          const pkg = ext.pythonPackage!;
          vfs.mkdirp(`/usr/lib/python/${name}`);
          for (const [fp, src] of Object.entries(pkg.files)) {
            // Ensure subdirectories exist for nested paths
            const parts = fp.split('/');
            if (parts.length > 1) {
              vfs.mkdirp(`/usr/lib/python/${name}/${parts.slice(0, -1).join('/')}`);
            }
            vfs.writeFile(`/usr/lib/python/${name}/${fp}`,
              new TextEncoder().encode(src));
          }
        }
      });
    }

    // Bootstrap VFS config data for Rust virtual commands (curl/wget/pkg/pip)
    {
      const enc = new TextEncoder();
      vfs.withWriteAccess(() => {
        vfs.mkdirp('/etc/codepod');

        // pkg policy
        const pkgPolicy = options.security?.packagePolicy ?? { enabled: false };
        vfs.writeFile('/etc/codepod/pkg-policy.json', enc.encode(JSON.stringify(pkgPolicy)));

        // pip registry (from PackageRegistry)
        const pkgRegistry = new PackageRegistry();
        const regData = pkgRegistry.available().map(n => {
          const m = pkgRegistry.get(n)!;
          return { name: m.name, version: m.version, summary: m.summary, dependencies: m.dependencies, files: m.pythonFiles };
        });
        vfs.writeFile('/etc/codepod/pip-registry.json', enc.encode(JSON.stringify(regData)));

        // pip installed state (include pre-installed packages from options.packages)
        const preInstalled: { name: string; version: string }[] = [];
        if (options.packages && options.packages.length > 0) {
          const preReg = new PackageRegistry();
          const resolved = new Set<string>();
          for (const name of options.packages) {
            for (const dep of preReg.resolveDeps(name)) resolved.add(dep);
          }
          for (const name of resolved) {
            const meta = preReg.get(name);
            if (meta) preInstalled.push({ name: meta.name, version: meta.version });
          }
        }
        vfs.writeFile('/etc/codepod/pip-installed.json', enc.encode(JSON.stringify(preInstalled)));

        // extension metadata
        const extMeta = extensionRegistry.list().map(e => ({
          name: e.name,
          description: e.description,
          hasCommand: !!e.command,
          pythonPackage: e.pythonPackage
            ? { version: e.pythonPackage.version, summary: e.pythonPackage.summary }
            : null,
        }));
        vfs.writeFile('/etc/codepod/extensions.json', enc.encode(JSON.stringify(extMeta)));
      });
    }

    // Set PYTHONPATH: user-provided paths + /usr/lib/python (always included)
    if (options.pythonPath || bridge || extensionRegistry.getPackageNames().length > 0 || (options.packages && options.packages.length > 0)) {
      const paths = [...(options.pythonPath ?? []), '/usr/lib/python'];
      runner.setEnv('PYTHONPATH', paths.join(':'));
    }

    // Create WorkerExecutor for hard-kill preemption when enabled.
    const workerExecutor = await Sandbox.createWorkerExecutor(
      vfs, options.wasmDir, shellExecWasmPath, tools, adapter,
      options.security, bridge, options.network, extensionRegistry,
    );

    const sb = new Sandbox({
      vfs, runner, timeoutMs, adapter,
      wasmDir: options.wasmDir, shellExecWasmPath,
      mgr, bridge, networkPolicy: options.network,
      security: options.security, workerExecutor,
      extensionRegistry,
    });

    // Wire persistence if configured
    const pMode = options.persistence?.mode ?? 'ephemeral';
    if (pMode !== 'ephemeral') {
      const backend = options.persistence?.backend ?? await Sandbox.detectBackend();
      const pm = new PersistenceManager(
        backend, vfs, options.persistence,
        () => runner.getEnvMap(),
        (env) => runner.setEnvMap(env),
      );
      sb.persistenceManager = pm;

      if (pMode === 'persistent') {
        await pm.load();
        pm.startAutosave(vfs);
      }
      // 'session' mode: user calls save()/load() explicitly
    }

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

  private static async detectBackend(): Promise<import('./persistence/backend.js').PersistenceBackend> {
    if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
      const { FsBackend } = await import('./persistence/fs-backend.js');
      return new FsBackend();
    }
    const { IdbBackend } = await import('./persistence/idb-backend.js');
    return new IdbBackend();
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

  private static async createWorkerExecutor(
    vfs: VFS,
    wasmDir: string,
    shellExecWasmPath: string,
    tools: Map<string, string>,
    adapter: PlatformAdapter,
    security?: SecurityOptions,
    bridge?: NetworkBridge,
    networkPolicy?: NetworkPolicy,
    extensionRegistry?: ExtensionRegistry,
  ): Promise<WorkerExecutor | undefined> {
    if (!security?.hardKill || !adapter.supportsWorkerExecution) return undefined;
    const { WorkerExecutor: WE } = await import('./execution/worker-executor.js');
    const toolRegistry: [string, string][] = Array.from(tools);
    if (!tools.has('python3')) {
      toolRegistry.push(['python3', `${wasmDir}/python3.wasm`]);
    }
    return new WE({
      vfs,
      wasmDir,
      shellExecWasmPath,
      toolRegistry,
      stdoutBytes: security.limits?.stdoutBytes,
      stderrBytes: security.limits?.stderrBytes,
      toolAllowlist: security.toolAllowlist,
      memoryBytes: security.limits?.memoryBytes,
      bridgeSab: bridge?.getSab(),
      networkPolicy: networkPolicy ? {
        allowedHosts: networkPolicy.allowedHosts,
        blockedHosts: networkPolicy.blockedHosts,
      } : undefined,
      extensionRegistry: extensionRegistry?.list().length ? extensionRegistry : undefined,
    });
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

  /**
   * Mount host-provided files (or a custom VirtualProvider) at the given path.
   *
   * Accepts either a flat file map `Record<string, Uint8Array>` (convenient)
   * or a `VirtualProvider` instance (flexible). Duck-types on `readFile` method.
   */
  mount(path: string, filesOrProvider: Record<string, Uint8Array> | VirtualProvider): void {
    this.assertAlive();
    const provider: VirtualProvider =
      typeof (filesOrProvider as VirtualProvider).readFile === 'function'
        ? (filesOrProvider as VirtualProvider)
        : new HostMount(filesOrProvider as Record<string, Uint8Array>);
    this.vfs.mount(path, provider);
  }

  setEnv(name: string, value: string): void {
    this.assertAlive();
    this.runner.setEnv(name, value);
  }

  getEnv(name: string): string | undefined {
    this.assertAlive();
    return this.runner.getEnv(name);
  }

  /** Return the command history entries. */
  getHistory(): HistoryEntry[] {
    this.assertAlive();
    return this.runner.getHistory();
  }

  /** Clear the command history. */
  clearHistory(): void {
    this.assertAlive();
    this.runner.clearHistory();
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

  /** Export the entire sandbox state (VFS files + env vars) as a binary blob. */
  exportState(): Uint8Array {
    this.assertAlive();
    return serializerExportState(this.vfs, this.runner.getEnvMap(), this.vfs.getProviderPaths());
  }

  /** Import a previously exported state blob, restoring files and env vars. */
  importState(blob: Uint8Array): void {
    this.assertAlive();
    const { env } = serializerImportState(this.vfs, blob);
    if (env) {
      this.runner.setEnvMap(env);
    }
  }

  /** Persist current state to the configured backend. Requires persistence mode. */
  async saveState(): Promise<void> {
    this.assertAlive();
    if (!this.persistenceManager) {
      throw new Error('Persistence not configured. Set persistence.mode to "session" or "persistent".');
    }
    await this.persistenceManager.save();
  }

  /** Load persisted state from the configured backend. Returns true if state was restored. */
  async loadState(): Promise<boolean> {
    this.assertAlive();
    if (!this.persistenceManager) {
      throw new Error('Persistence not configured. Set persistence.mode to "session" or "persistent".');
    }
    return this.persistenceManager.load();
  }

  /** Delete persisted state from the configured backend. */
  async clearPersistedState(): Promise<void> {
    this.assertAlive();
    if (!this.persistenceManager) {
      throw new Error('Persistence not configured. Set persistence.mode to "session" or "persistent".');
    }
    await this.persistenceManager.clear();
  }

  async fork(): Promise<Sandbox> {
    this.assertAlive();
    const childVfs = this.vfs.cowClone();
    const { gateway, bridge } = await Sandbox.createNetworkBridge(this.networkPolicy);
    const childMgr = new ProcessManager(childVfs, this.adapter, bridge, this.security?.toolAllowlist);
    const tools = await Sandbox.registerTools(childMgr, this.adapter, this.wasmDir);

    // Pre-load all tool modules so spawnSync can use them synchronously
    await childMgr.preloadModules();

    let childShellRef: ShellInstance | null = null;
    const secLimits = this.security?.limits;

    // Fork as ShellInstance — create a fresh instance and copy env
    const childRunner = await ShellInstance.create(childVfs, childMgr, this.adapter, this.shellExecWasmPath, {
      syncSpawn: (cmd, args, env, stdin, cwd) =>
        childMgr.spawnSync(cmd, args, env, stdin, cwd, {
          deadlineMs: childShellRef?.getDeadlineMs(),
          memoryBytes: secLimits?.memoryBytes,
        }),
      networkBridge: bridge,
      extensionRegistry: this.extensionRegistry ?? undefined,
      toolAllowlist: this.security?.toolAllowlist,
    });
    childShellRef = childRunner;

    // Wire output limits to forked runner
    if (secLimits) {
      childRunner.setOutputLimits(secLimits.stdoutBytes, secLimits.stderrBytes);
    }

    // Copy env
    const envMap = this.runner.getEnvMap();
    for (const [k, v] of envMap) {
      childRunner.setEnv(k, v);
    }

    // Create WorkerExecutor for the child if parent uses hard-kill
    const childWorkerExecutor = await Sandbox.createWorkerExecutor(
      childVfs, this.wasmDir, this.shellExecWasmPath, tools, this.adapter,
      this.security, bridge, this.networkPolicy, this.extensionRegistry ?? undefined,
    );

    return new Sandbox({
      vfs: childVfs, runner: childRunner, timeoutMs: this.timeoutMs,
      adapter: this.adapter, wasmDir: this.wasmDir, shellExecWasmPath: this.shellExecWasmPath,
      mgr: childMgr, bridge, networkPolicy: this.networkPolicy,
      security: this.security, workerExecutor: childWorkerExecutor,
      extensionRegistry: this.extensionRegistry ?? undefined,
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
    // Fire-and-forget: dispose is async but destroy is sync
    this.persistenceManager?.dispose().catch(() => {});
    this.workerExecutor?.dispose();
    this.bridge?.dispose();
    this.runner.destroy?.();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('Sandbox has been destroyed');
    }
  }
}
