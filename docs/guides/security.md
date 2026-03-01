# Security Architecture

codepod is designed to run untrusted LLM-generated code safely. This document describes the security architecture, threat model, and isolation boundaries.

## Design philosophy

**Defense-in-depth, default-deny.** Every layer assumes the layers above it have been compromised. No single bypass should grant full access.

- Network access is off by default
- File writes are restricted to designated paths
- Only allowlisted tools can be spawned
- WASI syscalls for sockets, signals, and polling return `ENOSYS`
- Resource consumption is bounded at every level

## Sandbox boundary

```
                    HOST SIDE                          SANDBOX SIDE
              ┌─────────────────────┐           ┌─────────────────────┐
              │                     │           │                     │
              │  TypeScript         │  WASI P1  │  Shell parser       │
              │  Orchestrator       │◄─────────►│  (Rust → WASM)      │
              │                     │  imports   │                     │
              │  - VFS (in-memory)  │           │  Coreutils           │
              │  - Process Manager  │           │  (Rust → WASM)      │
              │  - Network Gateway  │           │                     │
              │  - Security Policy  │           │  Python (RustPython) │
              │  - Extension Host   │           │  (Rust → WASM)      │
              │  - Audit Logger     │           │                     │
              │                     │           └─────────────────────┘
              │  Extensions ←───────│── Host callbacks (TypeScript/Python)
              │  (runs on host)     │
              └─────────────────────┘
```

Everything inside the sandbox (shell, coreutils, Python) runs as WebAssembly. Everything outside (orchestrator, extensions) runs on the host. The WASI P1 import boundary is the primary trust boundary.

## WASM isolation

Each command execution creates an **isolated WASM instance** with its own linear memory. There is no shared mutable state between command invocations — each `cat`, `grep`, or `python3` call gets a fresh WebAssembly module instance.

Key properties:

- **Memory isolation** — each WASM instance has its own linear memory; one command cannot read or write another's memory
- **No host process spawning** — WASM binaries cannot exec, fork, or spawn processes on the host
- **Deterministic teardown** — when a command finishes (or is killed), its entire WASM instance is discarded
- **Hard-kill support** — on Deno/Node.js, commands can run in a Worker thread; `Worker.terminate()` provides a non-cooperative kill mechanism that works even if the WASM binary enters an infinite loop

## VFS isolation

The filesystem is entirely in-memory. There is no host filesystem exposure unless the host explicitly mounts files.

- **Writable paths** — by default, only `/home/user` and `/tmp` are writable; writes to other paths return `EROFS`
- **Path traversal protection** — paths are normalized before access; `../` sequences cannot escape writable directories (tested in adversarial test suite)
- **Size limits** — configurable VFS size limit (default 256 MB) and file count limit prevent resource exhaustion
- **Mount isolation** — host-mounted files are read-only snapshots taken at mount time; the sandbox cannot write back to the host through mounts
- **Export exclusion** — virtual filesystems (`/dev`, `/proc`) and host mounts are excluded from state exports

## Network isolation

Network access follows a **default-deny** policy. When no network policy is configured, all network requests are blocked.

```typescript
// Default: all network blocked
const sb = await Sandbox.create({ wasmDir: './wasm' });

// Allowlist mode: only specified hosts
const sb = await Sandbox.create({
  wasmDir: './wasm',
  network: {
    allowedHosts: ['api.example.com', '*.cdn.example.com'],
  },
});
```

The `NetworkGateway` enforces:

- **Static host checks** — allowlist (whitelist mode) or blocklist (blacklist mode), with wildcard support (`*.example.com`)
- **Dynamic callback** — optional `onRequest` async callback for runtime allow/deny decisions
- **HTTP only** — network access goes through the host `fetch()` API; no raw sockets
- **Response size limits** — response bodies are streamed with configurable size caps (default 10 MB)
- **No WASI sockets** — `sock_recv`, `sock_send`, `sock_accept`, `sock_shutdown` all return `ENOSYS`

## Resource limits

Every resource consumption path has a configurable bound:

| Resource | Config field | Default | Enforcement |
|----------|-------------|---------|-------------|
| Command timeout | `limits.timeoutMs` | 30,000 ms | WASI deadline check on every I/O syscall + Worker.terminate() hard-kill |
| Stdout size | `limits.stdoutBytes` | 1 MB | Truncated at WASI `fd_write` level |
| Stderr size | `limits.stderrBytes` | 1 MB | Truncated at WASI `fd_write` level |
| VFS total size | `limits.fsBytes` | 256 MB | Checked on every file write |
| File count | `limits.fileCount` | Unlimited | Checked on file creation |
| Command length | `limits.commandBytes` | 64 KB | Checked before parsing |
| RPC payload | `limits.rpcBytes` | 8 MB | Checked on RPC message receipt |
| WASM memory | `limits.memoryBytes` | Unlimited | Module rejected at instantiation if initial memory exceeds limit |
| Substitution depth | (internal) | 50 levels | Nested `$(...)` beyond limit returns empty string |

Timeout enforcement is two-tier:
1. **Cooperative** — the WASI host checks a deadline on every syscall (`fd_write`, `fd_read`, `path_open`, `clock_time_get`, etc.) and throws `WasiExitError(124)` if expired
2. **Non-cooperative** — when `hardKill: true` is enabled, commands run in a Worker thread that is terminated via `Worker.terminate()` if the deadline passes, handling infinite loops and tight computation

## WASI capability table

The WASI P1 host implementation selectively provides syscalls:

| Category | Syscalls | Status |
|----------|----------|--------|
| **File I/O** | `fd_read`, `fd_write`, `fd_seek`, `fd_tell`, `fd_close`, `path_open` | Implemented — backed by in-memory VFS |
| **Directory ops** | `fd_readdir`, `path_create_directory`, `path_remove_directory`, `path_rename` | Implemented |
| **File metadata** | `fd_filestat_get`, `path_filestat_get`, `fd_fdstat_get`, `fd_prestat_get` | Implemented |
| **Symlinks** | `path_symlink`, `path_readlink` | Implemented (with loop detection) |
| **Clock** | `clock_time_get` | Implemented — returns wall-clock time |
| **Random** | `random_get` | Implemented — `crypto.getRandomValues()` |
| **Process** | `proc_exit` | Implemented — throws `WasiExitError` |
| **Scheduling** | `sched_yield` | Implemented — checks deadline, returns success |
| **Sync/timestamps** | `fd_advise`, `fd_allocate`, `fd_datasync`, `fd_sync`, `fd_fdstat_set_flags`, `fd_filestat_set_size`, `fd_filestat_set_times` | No-op (returns success) — safe to skip in single-threaded sandbox |
| **Sockets** | `sock_recv`, `sock_send`, `sock_accept`, `sock_shutdown` | **Blocked** — returns `ENOSYS` |
| **Signals** | `proc_raise` | **Blocked** — returns `ENOSYS` |
| **Polling** | `poll_oneoff` | **Blocked** — returns `ENOSYS` |
| **Advanced I/O** | `fd_pread`, `fd_pwrite`, `fd_renumber`, `path_link` | **Blocked** — returns `ENOSYS` |

## Tool allowlist

The orchestrator can restrict which commands are available:

```typescript
const sb = await Sandbox.create({
  wasmDir: './wasm',
  security: {
    toolAllowlist: ['echo', 'cat', 'grep', 'python3'],
  },
});
```

When a tool allowlist is set:
- Only listed tools can be spawned — all others return an error with "not allowed"
- The restriction is enforced at the process manager level, not the shell parser — this means blocked tools cannot be reached via pipes, command substitution, `source`, or any other shell mechanism
- Forked sandboxes inherit the parent's allowlist restrictions

## Extension trust model

Extensions are the **one intentional boundary crossing** in the security model. They execute host-side TypeScript/Python callbacks that have full host access.

This is by design — extensions exist precisely to give sandbox code access to capabilities that require host privileges (LLM APIs, databases, vector search, etc.).

The trust model:

- **Explicit registration** — extensions must be registered by the host application at sandbox creation time; sandbox code cannot register extensions
- **Host-side execution** — extension handlers run in the host process, not inside WASM
- **Structured interface** — extensions receive `args`, `stdin`, `env`, and `cwd`; they return `stdout`, optional `stderr`, and `exitCode`
- **No ambient authority** — extensions don't get automatic access to sandbox internals; they only see what the host passes them

The security implication: **trust your extension code the same way you trust your application code.** A malicious extension handler could do anything the host process can do. This is the correct tradeoff — the sandbox isolates untrusted *sandbox* code, while extensions are trusted *host* code.

## Package manager security

The package manager (`pkg install`) is **disabled by default**. When enabled:

- **Host allowlist** — only packages from explicitly allowed hosts can be installed
- **Size limit** — per-package size cap (configurable, e.g., 5 MB)
- **Count limit** — maximum number of installed packages
- **Name validation** — package names are validated to prevent path traversal (empty, `.`, `..`, and `/` are rejected)
- **WASM execution** — installed packages run inside the same WASM sandbox as built-in coreutils, with the same isolation guarantees

```typescript
security: {
  packagePolicy: {
    enabled: true,
    allowedHosts: ['trusted-registry.example.com'],
    maxPackageBytes: 5 * 1024 * 1024,
    maxInstalledPackages: 50,
  },
}
```

## Audit events

The sandbox emits structured audit events for security-relevant actions:

```typescript
const sb = await Sandbox.create({
  wasmDir: './wasm',
  security: {
    onAuditEvent: (event) => {
      console.log(event.type, event.sessionId, event.timestamp);
    },
  },
});
```

Each event includes:
- `type` — event category (e.g., lifecycle, command execution, security violation)
- `sessionId` — identifies the sandbox instance
- `timestamp` — Unix timestamp
- Additional fields depending on event type

## Security test coverage

The codebase includes dedicated security tests:

- **Adversarial input tests** (`security-adversarial.test.ts`) — probe bypass attempts:
  - Blocked tools via pipes, command substitution, and `source`
  - Path traversal via `..` sequences
  - Deeply nested command substitution (depth limit enforcement)
  - Output truncation under repeated writes
  - Command length rejection
  - Symlink chain loop detection
  - Fork inheriting allowlist restrictions

- **Gateway tests** (`gateway.test.ts`) — network policy enforcement:
  - Default-deny when no policy configured
  - Allowlist and blocklist modes
  - Wildcard host matching
  - Invalid URL handling

- **VFS tests** — filesystem isolation:
  - Write restriction enforcement
  - Host mount read-only behavior
  - Snapshot/restore consistency

## What's sandboxed vs. what's host-side

| Component | Where it runs | Trust level |
|-----------|--------------|-------------|
| Shell parser | WASM sandbox | Untrusted — parses arbitrary input |
| Coreutils (cat, grep, sed, ...) | WASM sandbox | Untrusted — processes arbitrary data |
| Python (RustPython) | WASM sandbox | Untrusted — executes arbitrary scripts |
| Installed packages (pkg) | WASM sandbox | Untrusted — same boundary as coreutils |
| VFS | Host (in-memory) | Trusted — mediates all file access |
| Process manager | Host | Trusted — spawns/kills WASM instances |
| Network gateway | Host | Trusted — enforces network policy |
| Extension handlers | Host | Trusted — full host access by design |
| MCP server | Host | Trusted — wraps orchestrator for MCP clients |
| Persistence backends | Host | Trusted — serializes VFS to storage |

## Status

The security model is defense-in-depth but **has not been formally audited or pen-tested against adversarial untrusted input in production**. The WASM sandbox provides strong isolation guarantees by construction, but the orchestrator and policy enforcement layers are conventional TypeScript code that could have bugs.

For production use with untrusted input, consider:
- Enabling `hardKill: true` for non-cooperative timeout enforcement
- Setting explicit resource limits for all categories
- Using a tool allowlist to minimize attack surface
- Keeping network access disabled or tightly scoped
- Reviewing extension handlers for security implications
