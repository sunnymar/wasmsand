/**
 * JSON-RPC method dispatcher.
 *
 * Maps RPC method names to Sandbox method calls. The dispatcher is
 * transport-agnostic — it receives a method name + params object and
 * returns (or throws) the response payload.
 */

/** Minimal interface for a sandbox, matching the methods we call. */
export interface SandboxLike {
  run(command: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    executionTimeMs: number;
    truncated?: { stdout: boolean; stderr: boolean };
    errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
  }>;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  readDir(path: string): Array<{ name: string; type: 'file' | 'dir' | 'symlink' }>;
  mkdir(path: string): void;
  stat(path: string): {
    type: 'file' | 'dir' | 'symlink';
    size: number;
    permissions: number;
    mtime: Date;
    ctime: Date;
    atime: Date;
  };
  rm(path: string): void;
  setEnv(name: string, value: string): void;
  getEnv(name: string): string | undefined;
  destroy(): void;
  snapshot(): string;
  restore(id: string): void;
  fork(): Promise<SandboxLike>;
  exportState(): Uint8Array;
  importState(blob: Uint8Array): void;
  getHistory(): Array<{ index: number; command: string; timestamp: number }>;
  clearHistory(): void;
  mount(path: string, filesOrProvider: Record<string, Uint8Array>): void;
}

export interface RpcError {
  code: number;
  message: string;
}

/** Maximum number of concurrent forked sandboxes. */
const MAX_FORKS = 16;

/** Maximum number of named sandboxes in multi-sandbox mode. */
const MAX_SANDBOXES = 64;

interface SandboxEntry {
  sandbox: SandboxLike;
  label?: string;
  createdAt: string;
}

export class Dispatcher {
  private sandbox: SandboxLike | null;
  private killed = false;
  private forks: Map<string, SandboxLike> = new Map();
  private nextForkId = 1;
  private sandboxes: Map<string, SandboxEntry> = new Map();
  private nextSandboxId = 1;
  private pool?: { checkout(opts?: { label?: string }): Promise<SandboxLike>; release(sb: SandboxLike): void; drain(): Promise<void> };
  private sandboxOptions?: unknown;

  constructor(
    sandbox: SandboxLike | null,
    options?: { pool?: any; sandboxOptions?: any },
  ) {
    this.sandbox = sandbox;
    this.pool = options?.pool;
    this.sandboxOptions = options?.sandboxOptions;
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      switch (method) {
        case 'run':
          return await this.run(params);
        case 'files.write':
          return this.filesWrite(params);
        case 'files.read':
          return this.filesRead(params);
        case 'files.list':
          return this.filesList(params);
        case 'files.mkdir':
          return this.filesMkdir(params);
        case 'files.rm':
          return this.filesRm(params);
        case 'files.stat':
          return this.filesStat(params);
        case 'env.set':
          return this.envSet(params);
        case 'env.get':
          return this.envGet(params);
        case 'kill':
          return await this.kill();
        case 'snapshot.create':
          return this.snapshotCreate(params);
        case 'snapshot.restore':
          return this.snapshotRestore(params);
        case 'sandbox.fork':
          return await this.sandboxFork(params);
        case 'sandbox.destroy':
          return this.sandboxDestroy(params);
        case 'sandbox.create':
          return await this.sandboxCreate(params);
        case 'sandbox.list':
          return this.sandboxList();
        case 'sandbox.remove':
          return await this.sandboxRemove(params);
        case 'persistence.export':
          return this.persistenceExport(params);
        case 'persistence.import':
          return this.persistenceImport(params);
        case 'mount':
          return this.mountFiles(params);
        case 'shell.history.list':
          return this.shellHistoryList(params);
        case 'shell.history.clear':
          return this.shellHistoryClear(params);
        default:
          throw this.rpcError(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      // Re-throw RPC errors as-is
      if (err && typeof err === 'object' && 'code' in err) {
        throw err;
      }
      // Wrap sandbox/VFS errors with code 1
      throw this.rpcError(1, (err as Error).message);
    }
  }

  isKilled(): boolean {
    return this.killed;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private requireString(params: Record<string, unknown>, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') {
      throw this.rpcError(-32602, `Missing required param: ${key}`);
    }
    return value;
  }

  private rpcError(code: number, message: string): RpcError {
    return { code, message };
  }

  private resolveSandbox(params: Record<string, unknown>): SandboxLike {
    const id = params.sandboxId;
    if (id === undefined || id === null) {
      // No sandboxId specified — return root sandbox if set
      if (this.sandbox !== null) return this.sandbox;
      // Fall back to 'default' in sandboxes map
      const defaultEntry = this.sandboxes.get('default');
      if (defaultEntry) return defaultEntry.sandbox;
      throw this.rpcError(-32602, 'No root sandbox available');
    }
    if (typeof id !== 'string') throw this.rpcError(-32602, 'sandboxId must be a string');
    // Check sandboxes map first, then forks map
    const entry = this.sandboxes.get(id);
    if (entry) return entry.sandbox;
    const fork = this.forks.get(id);
    if (fork) return fork;
    throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
  }

  /** Extract the basename from a path (last segment after '/'). */
  private basename(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  // ── RPC method implementations ───────────────────────────────────

  private async run(params: Record<string, unknown>) {
    const command = this.requireString(params, 'command');
    if (command.length > 65536) {
      throw this.rpcError(-32602, 'Command too large');
    }
    const sb = this.resolveSandbox(params);
    const result = await sb.run(command);
    const response: Record<string, unknown> = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: result.executionTimeMs,
    };
    if (result.truncated) response.truncated = result.truncated;
    if (result.errorClass) response.errorClass = result.errorClass;
    return response;
  }

  private filesWrite(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    const data = this.requireString(params, 'data');
    const bytes = Buffer.from(data, 'base64');
    sb.writeFile(path, new Uint8Array(bytes));
    return { ok: true };
  }

  private filesRead(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    const content = sb.readFile(path);
    const encoded = Buffer.from(content).toString('base64');
    return { data: encoded };
  }

  private filesList(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    const entries = sb.readDir(path);
    const enriched = entries.map((entry) => {
      const fullPath = path.endsWith('/')
        ? `${path}${entry.name}`
        : `${path}/${entry.name}`;
      const st = sb.stat(fullPath);
      return { name: entry.name, type: entry.type, size: st.size };
    });
    return { entries: enriched };
  }

  private filesMkdir(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    sb.mkdir(path);
    return { ok: true };
  }

  private filesRm(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    sb.rm(path);
    return { ok: true };
  }

  private filesStat(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    const st = sb.stat(path);
    return {
      name: this.basename(path),
      type: st.type,
      size: st.size,
    };
  }

  private envSet(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const name = this.requireString(params, 'name');
    const value = this.requireString(params, 'value');
    sb.setEnv(name, value);
    return { ok: true };
  }

  private envGet(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const name = this.requireString(params, 'name');
    const value = sb.getEnv(name);
    return { value: value ?? null };
  }

  private async kill() {
    // Destroy all named sandboxes
    for (const entry of this.sandboxes.values()) {
      if (this.pool) {
        this.pool.release(entry.sandbox as any);
      } else {
        entry.sandbox.destroy();
      }
    }
    this.sandboxes.clear();

    // Destroy all forks
    for (const fork of this.forks.values()) {
      fork.destroy();
    }
    this.forks.clear();

    // Destroy root sandbox if set
    if (this.sandbox !== null) {
      this.sandbox.destroy();
    }

    // Drain pool if set
    if (this.pool) {
      await this.pool.drain();
    }

    this.killed = true;
    return { ok: true };
  }

  private snapshotCreate(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const id = sb.snapshot();
    return { id };
  }

  private snapshotRestore(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const id = this.requireString(params, 'id');
    sb.restore(id);
    return { ok: true };
  }

  private async sandboxFork(params: Record<string, unknown>) {
    if (this.forks.size >= MAX_FORKS) {
      throw this.rpcError(-32602, `Maximum of ${MAX_FORKS} concurrent forks reached`);
    }
    const sb = this.resolveSandbox(params);
    const child = await sb.fork();
    const sandboxId = String(this.nextForkId++);
    this.forks.set(sandboxId, child);
    return { sandboxId };
  }

  private sandboxDestroy(params: Record<string, unknown>) {
    const id = this.requireString(params, 'sandboxId');
    const fork = this.forks.get(id);
    if (!fork) throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
    fork.destroy();
    this.forks.delete(id);
    return { ok: true };
  }

  private async sandboxCreate(params: Record<string, unknown>) {
    if (this.sandboxes.size >= MAX_SANDBOXES) {
      throw this.rpcError(-32602, `Maximum of ${MAX_SANDBOXES} concurrent sandboxes reached`);
    }
    const label = typeof params.label === 'string' ? params.label : undefined;

    let sb: SandboxLike;
    if (this.pool) {
      sb = await this.pool.checkout({ label });
    } else if (this.sandboxOptions) {
      const { Sandbox } = await import('@codepod/sandbox');
      sb = await Sandbox.create(this.sandboxOptions as any);
    } else {
      throw this.rpcError(-32602, 'No pool or sandboxOptions configured for sandbox.create');
    }

    const sandboxId = String(this.nextSandboxId++);
    this.sandboxes.set(sandboxId, {
      sandbox: sb,
      label,
      createdAt: new Date().toISOString(),
    });
    return { sandboxId };
  }

  private sandboxList() {
    const entries = Array.from(this.sandboxes.entries()).map(([sandboxId, entry]) => ({
      sandboxId,
      label: entry.label,
      createdAt: entry.createdAt,
    }));
    return entries;
  }

  private async sandboxRemove(params: Record<string, unknown>) {
    const sandboxId = this.requireString(params, 'sandboxId');
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw this.rpcError(-32602, `Unknown sandboxId: ${sandboxId}`);

    if (this.pool) {
      this.pool.release(entry.sandbox as any);
    } else {
      entry.sandbox.destroy();
    }
    this.sandboxes.delete(sandboxId);
    return { ok: true };
  }

  private persistenceExport(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const blob = sb.exportState();
    return { data: Buffer.from(blob).toString('base64') };
  }

  private persistenceImport(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const data = this.requireString(params, 'data');
    sb.importState(new Uint8Array(Buffer.from(data, 'base64')));
    return { ok: true };
  }

  private mountFiles(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const path = this.requireString(params, 'path');
    const filesRaw = params.files;
    if (!filesRaw || typeof filesRaw !== 'object') {
      throw this.rpcError(-32602, 'Missing required param: files');
    }
    const decoded: Record<string, Uint8Array> = {};
    for (const [key, value] of Object.entries(filesRaw as Record<string, string>)) {
      decoded[key] = new Uint8Array(Buffer.from(value, 'base64'));
    }
    sb.mount(path, decoded);
    return { ok: true };
  }

  private shellHistoryList(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    const entries = sb.getHistory();
    return { entries };
  }

  private shellHistoryClear(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    sb.clearHistory();
    return { ok: true };
  }
}
