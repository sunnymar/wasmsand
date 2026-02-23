# Shell Builtins, Network Access, and Snapshot/Fork API

**Date:** 2026-02-23
**Status:** Approved

## Overview

Three feature sets addressing gaps identified in code review:

1. **Shell builtins** — `cd`, `export`, `unset`, `date`
2. **Network access** — `curl`/`wget` builtins + WASI socket bridge + NetworkGateway policy enforcement
3. **Snapshot/fork API** — expose VFS snapshot/fork capabilities at Sandbox, RPC, and SDK levels

## Feature A: Shell Builtins

### New builtins in ShellRunner

Added to `SHELL_BUILTINS` set and dispatched in `execSimple()`, following the existing pattern (`which`, `chmod`, `test`, `pwd`).

**`cd [dir]`**
- Sets `PWD` env var after validating target exists in VFS and is a directory.
- `cd` (no args) → `/home/user`
- `cd -` → `OLDPWD` (also sets `OLDPWD` to previous `PWD` on every cd)
- `cd ..` works via VFS `parsePath()` which already resolves `..`

**`export [NAME=value]`**
- Alias for variable assignment. `export FOO=bar` → `env.set('FOO', 'bar')`.
- `export FOO` with no value → no-op (variable already visible to all processes).
- Bare `export` (no args) → lists all env vars.

**`unset NAME`**
- Removes variable from env map. `env.delete(name)`.

**`date [+FORMAT]`**
- No args: returns current date in default format (`Thu Feb 23 14:30:00 UTC 2026`).
- `+FORMAT`: strftime-like formatting (`%Y-%m-%d`, `%H:%M:%S`, etc.).
- Pure JS implementation using `Date` and `Intl.DateTimeFormat`.

## Feature B: Network Access

### Architecture

```
NetworkGateway (shared policy enforcement)
  ├── holds NetworkPolicy
  ├── checkAccess(url, method) → allow/deny
  └── fetch(url, options) → Response

Consumers:
  ├── curl builtin (ShellRunner) → awaits gateway.fetch()
  ├── wget builtin (ShellRunner) → awaits gateway.fetch()
  └── WASI sock_* (WasiHost) → SAB bridge → gateway.fetch()
```

### NetworkPolicy

```typescript
interface NetworkPolicy {
  /** Whitelist mode: only these hosts allowed. */
  allowedHosts?: string[];
  /** Blacklist mode: these hosts blocked. Ignored if allowedHosts is set. */
  blockedHosts?: string[];
  /** Async callback for dynamic allow/deny. Called after static checks pass. */
  onRequest?: (request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }) => Promise<boolean>;
}
```

**Default behavior:** If neither `allowedHosts` nor `blockedHosts` is set, all network access is **blocked** (safe default). The `onRequest` callback is a second gate — even if host checks pass, the callback can deny.

### NetworkGateway

Standalone class in `packages/orchestrator/src/network/gateway.ts`.

- `constructor(policy: NetworkPolicy)`
- `async fetch(url: string, options?: RequestInit): Promise<Response>` — checks policy, calls host `fetch()`
- `checkAccess(url: string, method: string): { allowed: boolean; reason?: string }` — synchronous check against allow/block lists
- Throws `NetworkAccessDenied` error with informative message on denial.

### curl/wget builtins

Shell builtins in ShellRunner. Run in host JS context, so they can `await gateway.fetch()`.

**curl** supports:
- `-X METHOD` (default GET)
- `-H "Header: Value"` (repeatable)
- `-d data` / `--data data` (sets method to POST if not specified)
- `-o file` (write output to VFS file instead of stdout)
- `-s` / `--silent` (suppress progress/error messages)
- `-L` / `--location` (follow redirects — default on)
- `-I` / `--head` (HEAD request, print headers)

**wget** supports:
- `-O file` (output file, `-` for stdout)
- `-q` (quiet)
- Default: downloads to VFS file named from URL basename

### WASI Socket Bridge (Python networking)

**Problem:** WASM execution is synchronous. WASI host functions can't `await fetch()`.

**Solution:** SharedArrayBuffer + Atomics for sync ↔ async bridging.

```
Python → socket.connect/send/recv → RustPython → WASI sock_send/sock_recv
  → WasiHost writes request to SharedArrayBuffer
  → WasiHost calls Atomics.wait() (blocks synchronously)
  → Fetch Worker calls gateway.fetch(), writes response to SAB
  → Fetch Worker calls Atomics.notify()
  → WasiHost unblocks, returns data to WASM → Python
```

**Node/Bun:** Atomics.wait() works on main thread natively.

**Browser:** WASM must run in a Web Worker (Atomics.wait blocked on main thread). This may require changes to BrowserAdapter.

**Implementation:**
- New `NetworkBridge` class manages the SAB and worker communication.
- WasiHost receives a `NetworkBridge` instance (optional — only if NetworkPolicy is set).
- `sock_send` → serializes HTTP request into SAB → Atomics.wait → returns response bytes
- `sock_recv` → reads buffered response data
- `sock_shutdown` → cleanup

### SandboxOptions addition

```typescript
interface SandboxOptions {
  // ... existing fields
  network?: NetworkPolicy;
}
```

Sandbox creates `NetworkGateway` from policy, passes it to ShellRunner (for builtins) and creates `NetworkBridge` for WasiHost (for WASI sockets).

## Feature C: Snapshot/Fork API

### Sandbox API

```typescript
class Sandbox {
  /** Save current VFS + env state. Returns snapshot ID. */
  snapshot(): string;

  /** Restore VFS + env to a previously captured snapshot. */
  restore(id: string): void;

  /** Create an independent forked sandbox (COW VFS, inherited env). */
  fork(): Promise<Sandbox>;
}
```

### snapshot()/restore() implementation

- `snapshot()`: calls `vfs.snapshot()` for filesystem, deep-copies current env Map, stores both keyed by snapshot ID.
- `restore(id)`: calls `vfs.restore(id)` for filesystem, replaces ShellRunner env with saved copy.
- Snapshots are reusable (restore doesn't consume them).

### fork() implementation

1. COW-clone the VFS via `vfs.cowClone()`
2. Create new `ProcessManager` + `ShellRunner` around cloned VFS
3. Copy current env vars to new ShellRunner
4. Reuse same `PlatformAdapter` (stateless) and wasmDir config
5. Copy `NetworkPolicy` to forked sandbox (same rules)
6. Return new independent `Sandbox`

### RPC/Dispatcher additions

New methods in `dispatcher.ts`:

| Method | Params | Returns |
|---|---|---|
| `snapshot.create` | `{}` | `{ id: string }` |
| `snapshot.restore` | `{ id: string }` | `{ ok: true }` |
| `sandbox.fork` | `{}` | `{ sandboxId: string }` |

For `sandbox.fork`, the SDK server manages multiple sandbox instances. The response includes a `sandboxId` that subsequent RPC calls can target. The server needs a sandbox registry (Map<string, Sandbox>), and all RPC messages get an optional `sandboxId` field to route to the right instance.

### Python SDK additions

```python
class Sandbox:
    def snapshot(self) -> str:
        """Save current state, returns snapshot ID."""

    def restore(self, snapshot_id: str) -> None:
        """Restore to a previous snapshot."""

    def fork(self) -> 'Sandbox':
        """Create an independent forked sandbox."""
```

For `fork()`, the Python SDK creates a new `Sandbox` object that shares the same subprocess but targets a different `sandboxId` in RPC calls.

## Implementation order

1. Shell builtins (no dependencies, immediate value)
2. NetworkGateway + NetworkPolicy (foundation for networking)
3. curl/wget builtins (depends on gateway)
4. Snapshot/fork Sandbox API (independent of networking)
5. Snapshot/fork RPC + Python SDK (depends on #4)
6. WASI socket bridge via SAB (depends on gateway, most complex)
