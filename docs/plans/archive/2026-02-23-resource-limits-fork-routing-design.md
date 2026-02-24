# Resource Limits + Fork RPC Routing Design

## Context

Code review identified two P0 gaps:
1. No stdout/stderr/command/RPC byte caps or file-count limits — hostile input can OOM the host.
2. Fork API is broken over RPC — dispatcher stores forked sandboxes but no RPC method can target them.

This design addresses both as quick wins before the larger hard-kill work.

## Item 1: Resource Limits

### Where limits are enforced

| Limit | Enforced in | Mechanism |
|-------|------------|-----------|
| `stdoutBytes` / `stderrBytes` | `Sandbox.run()` | Post-execution truncation + `truncated` flags |
| `commandBytes` | `Sandbox.run()` | Pre-execution length check, reject with errorClass |
| `rpcBytes` | `server.ts` | Lower `MAX_LINE_BYTES` from 400MB to 8MB |
| `fileCount` | `VFS` | Counter incremented on create, decremented on delete, checked before mutation |

### Defaults

```
stdoutBytes:  1_048_576    (1 MB)
stderrBytes:  1_048_576    (1 MB)
commandBytes: 65_536       (64 KB)
rpcBytes:     8_388_608    (8 MB)
fileCount:    10_000
```

### SandboxOptions extension

```ts
interface SandboxOptions {
  // ... existing fields ...
  limits?: {
    stdoutBytes?: number;
    stderrBytes?: number;
    commandBytes?: number;
    fileCount?: number;
  };
}
```

`rpcBytes` stays in `server.ts` as a transport concern, not in `SandboxOptions`.

### RunResult extension

```ts
interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
}
```

- `truncated` is only present when at least one stream was truncated.
- `errorClass` is `TIMEOUT` for the existing timeout path, `LIMIT_EXCEEDED` for command-too-long.
- Other error classes (`CANCELLED`, `CAPABILITY_DENIED`) come in later phases.

### Truncation strategy

Truncate after execution returns, in `Sandbox.run()`. This is simpler than intercepting mid-execution (which would require threading limits through every `execCommand` path in the shell runner). The WASM execution is synchronous and memory-bounded — the risk is returning a giant string to the caller, which post-return truncation handles.

### VFS file-count tracking

Add `fileCount` and `maxFileCount` to VFS:
- Increment in `writeFile` (new file only), `mkdir`, `mkdirp`, `symlink`.
- Decrement in `unlink`, `rmdir`.
- Check before increment; throw `ENOSPC` on limit.
- `cowClone` copies `fileCount`, `maxFileCount`, `fsLimitBytes`, `totalBytes`, and `writablePaths` from parent (currently `fromRoot` drops all of these).

### Python SDK types

Add optional `truncated` dict and `error_class` string to `CommandResult`.

## Item 2: Fork RPC Routing

### Problem

`dispatcher.ts` stores forked sandboxes in `this.forks` but every method operates on `this.sandbox`. No RPC method can target a fork. Python SDK `fork()` ignores the returned `sandboxId`.

### Design: per-request `sandboxId` field

Every RPC request accepts an optional `sandboxId` string param. The dispatcher resolves the target sandbox before dispatch:

```ts
private resolveSandbox(params: Record<string, unknown>): SandboxLike {
  const id = params.sandboxId;
  if (id === undefined || id === null) return this.sandbox;
  if (typeof id !== 'string') throw this.rpcError(-32602, 'sandboxId must be a string');
  const fork = this.forks.get(id);
  if (!fork) throw this.rpcError(-32602, `Unknown sandboxId: ${id}`);
  return fork;
}
```

- No `sandboxId` or `null` → root sandbox. Fully backwards-compatible.
- `sandbox.fork` supports forking from any sandbox via `sandboxId` (fork-from-fork).
- New `sandbox.destroy` method destroys a specific fork by `sandboxId` and removes it from the map.
- Existing `kill` destroys root + all forks and exits the process.

### Python SDK changes

- Add `_sandbox_id` field to `Sandbox`, default `None` for root.
- Add `_with_id(params)` helper that injects `sandboxId` when non-None.
- `Commands` and `Files` classes accept optional `sandbox_id` and inject into every RPC call.
- `fork()` returns a new `Sandbox` with the fork's `sandboxId` set, sharing the same `RpcClient`.

### COW clone fix

`VFS.cowClone()` → `VFS.fromRoot()` currently drops `fsLimitBytes`, `writablePaths`, `maxFileCount`. Fix to propagate these from parent. Copy parent's `fileCount` and `totalBytes` since COW clone is a structural copy.

### Wire format

```json
{"jsonrpc":"2.0","id":3,"method":"run","params":{"command":"ls","sandboxId":"1"}}
```

## Files changed

| File | Changes |
|------|---------|
| `orchestrator/src/sandbox.ts` | `limits` option, truncation + `errorClass` in `run()`, command length check |
| `orchestrator/src/shell/shell-runner.ts` | `truncated` and `errorClass` fields on `RunResult` |
| `orchestrator/src/vfs/vfs.ts` | `fileCount`/`maxFileCount`, enforce on mutations, propagate in `cowClone`/`fromRoot` |
| `sdk-server/src/dispatcher.ts` | `resolveSandbox()`, thread through all methods, `sandbox.destroy` |
| `sdk-server/src/server.ts` | Lower `MAX_LINE_BYTES` to 8MB |
| `python-sdk/src/wasmsand/sandbox.py` | `_sandbox_id`, `_with_id()`, fix `fork()` |
| `python-sdk/src/wasmsand/commands.py` | Accept + inject `sandbox_id` |
| `python-sdk/src/wasmsand/files.py` | Accept + inject `sandbox_id` |
| `python-sdk/src/wasmsand/_types.py` | `truncated` + `error_class` on `CommandResult` |
