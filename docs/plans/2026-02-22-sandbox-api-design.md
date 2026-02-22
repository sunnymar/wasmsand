# Sandbox API — Design

**Goal:** Ship a public `Sandbox` class that makes wasmsand usable as a library. One call to create a sandbox, one call to run commands, simple file I/O methods. Works in both Node and browser via the existing platform adapter.

**Approach:** Thin facade over existing internals (VFS, ProcessManager, ShellRunner, PlatformAdapter). No new execution logic — just wiring and a clean public surface. Convention-based tool discovery: point to a directory of `.wasm` files and everything is auto-registered.

**Future:** Python and Rust SDKs will wrap this TypeScript API (separate phase).

---

## Public API

```typescript
interface SandboxOptions {
  /** Directory (Node) or URL base (browser) containing .wasm files. */
  wasmDir: string;
  /** Per-command wall-clock timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max VFS size in bytes. Default 256MB. */
  fsLimitBytes?: number;
}

class Sandbox {
  static async create(options: SandboxOptions): Promise<Sandbox>;

  // Run a shell command
  run(command: string): Promise<RunResult>;

  // File I/O (sync — VFS is in-memory)
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  readDir(path: string): DirEntry[];
  mkdir(path: string): void;
  stat(path: string): StatResult;
  rm(path: string): void;

  // Environment
  setEnv(name: string, value: string): void;
  getEnv(name: string): string | undefined;

  // Lifecycle
  destroy(): void;
}
```

Key decisions:
- `create()` is async — scans `wasmDir` for available tools.
- File I/O methods are sync — VFS is in-memory.
- `run()` is async — WASM execution.
- No snapshot/restore — deferred to a future phase.
- No network capability bridge — deferred.

---

## Internal Architecture

```
Sandbox.create(opts)
  │
  ├─ Detect platform (Node vs browser)
  │   ├─ Node:   NodeAdapter + scan wasmDir with fs.readdir()
  │   └─ Browser: BrowserAdapter + fetch manifest or known tool list
  │
  ├─ Create VFS (with fsLimitBytes enforcement)
  ├─ Create ProcessManager, register discovered tools
  ├─ Create ShellRunner
  │
  └─ Return Sandbox instance

Sandbox.run(command)
  │
  ├─ Wrap ShellRunner.run() with timeout (Promise.race)
  ├─ On success: return RunResult
  └─ On timeout: return exitCode=124, stderr="command timed out"
```

### Convention-Based Tool Discovery

- **Node:** `fs.readdir(wasmDir)` — every `*.wasm` file becomes a tool. Filename minus `.wasm` is the tool name. Special case: `true-cmd.wasm` → `true`, `false-cmd.wasm` → `false`.
- **Browser:** Hardcoded tool list (same as `packages/web/src/main.ts`). Browser can't readdir a URL, so we enumerate known tools and map to `${wasmDir}/${tool}.wasm` URLs.

`scanTools` added to the `PlatformAdapter` interface so `Sandbox.create()` is platform-agnostic.

### VFS Size Limit

Enforced in `VFS.writeFile()` — track total bytes across all files, reject writes exceeding `fsLimitBytes` with an ENOSPC error. Default 256MB.

### Command Timeout

`Promise.race` between `ShellRunner.run()` and a timer. On timeout, return `{ exitCode: 124, stdout: '', stderr: 'command timed out\n', executionTimeMs: timeoutMs }`. Exit code 124 matches the GNU `timeout` convention.

---

## Files

**New:**
- `packages/orchestrator/src/sandbox.ts` — The `Sandbox` class.
- `packages/orchestrator/src/sandbox.test.ts` — Tests for the public API.

**Modified:**
- `packages/orchestrator/src/index.ts` — Export `Sandbox` and `SandboxOptions`.
- `packages/orchestrator/src/vfs/vfs.ts` — Add `fsLimitBytes` option and total size tracking.
- `packages/orchestrator/src/platform/adapter.ts` — Add `scanTools` to interface.
- `packages/orchestrator/src/platform/node-adapter.ts` — Implement `scanTools` (readdir).
- `packages/orchestrator/src/platform/browser-adapter.ts` — Implement `scanTools` (hardcoded list).

**Unchanged:** ShellRunner, ProcessManager, web package.

---

## Testing

Unit tests in `sandbox.test.ts`:
- `Sandbox.create()` discovers tools from fixtures directory
- `run('echo hello')` returns correct RunResult
- `writeFile` then `run('cat /path')` reads back correctly
- `readFile` / `writeFile` / `readDir` / `mkdir` / `stat` / `rm` work
- `setEnv` / `getEnv` flow through to commands (`printenv`)
- `destroy()` is idempotent
- Timeout: command exceeding `timeoutMs` returns exitCode 124
- VFS limit: writing beyond `fsLimitBytes` throws ENOSPC
- Pipelines, chaining, Python all work through the facade
