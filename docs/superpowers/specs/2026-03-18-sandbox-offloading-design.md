# Sandbox Offloading via Storage Callbacks

Allow SDK consumers to offload inactive sandboxes to external storage and rehydrate them later, freeing memory without losing state. Storage is consumer-provided via callbacks — codepod handles serialization, the consumer handles persistence.

## Goal

Add `offload()` and `rehydrate()` methods to the Sandbox class, backed by consumer-provided `save`/`load` callbacks. This lets applications manage many sandboxes without holding all their file contents in memory simultaneously.

## Background

Codepod already has `exportState()` (returns a `Uint8Array` blob containing VFS user files, env, history) and `importState(blob)` (restores from blob). These are the serialization primitives. What's missing is:
- A lifecycle around "this sandbox is offloaded" vs "this sandbox is active"
- A callback mechanism to delegate storage to the consumer
- VFS content clearing to actually free memory after export

## Key Design Decision: VFS-only offload

Offloading does NOT destroy or recreate the shell runner, WASM modules, ProcessManager, NetworkBridge, or config files. It only clears the VFS user file contents (the `Uint8Array` buffers in the inode tree) to free memory. The sandbox infrastructure stays alive.

**Why:** `Sandbox.create()` does extensive setup — loading WASM modules, registering tools, writing config files to `/etc/codepod/`, installing packages. Tearing this down and recreating it is expensive, error-prone, and unnecessary. The dominant memory consumer is file content, not infrastructure.

**What `exportState()` captures:** Files under `/home`, `/tmp`, `/usr/lib/python`, `/usr/share/pkg`, plus environment variables and command history. Config files under `/etc/codepod/` and tool binaries under `/usr/bin/` are NOT exported (filtered by `SAFE_IMPORT_PREFIXES` in the serializer). This is fine because they survive offload — we don't destroy the VFS structure, just clear user file content.

## Design

### TypeScript SDK

```typescript
const sandbox = await Sandbox.create({
  storage: {
    save: async (sandboxId: string, state: Uint8Array) => {
      await fs.writeFile(`/tmp/${sandboxId}.bin`, state);
    },
    load: async (sandboxId: string) => {
      return await fs.readFile(`/tmp/${sandboxId}.bin`);
    },
  },
});

await sandbox.run('echo hello > /tmp/work.txt');
await sandbox.offload();       // state saved, VFS content cleared
// ... time passes ...
await sandbox.rehydrate();     // state loaded, VFS content restored
await sandbox.run('cat /tmp/work.txt');  // "hello\n"
```

**`StorageCallbacks` interface:**

```typescript
export interface StorageCallbacks {
  save: (sandboxId: string, state: Uint8Array) => Promise<void>;
  load: (sandboxId: string) => Promise<Uint8Array>;
}
```

Passed as `storage` in `Sandbox.create()` options. Optional — if not provided, `offload()`/`rehydrate()` throw.

### Python SDK

```python
def on_save(sandbox_id: str, state: bytes) -> None:
    with open(f"/tmp/{sandbox_id}.bin", "wb") as f:
        f.write(state)

def on_load(sandbox_id: str) -> bytes:
    with open(f"/tmp/{sandbox_id}.bin", "rb") as f:
        return f.read()

with Sandbox(storage={"save": on_save, "load": on_load}) as sb:
    sb.commands.run("echo hello > /tmp/work.txt")
    sb.offload()
    # ... time passes ...
    sb.rehydrate()
    sb.commands.run("cat /tmp/work.txt")  # "hello\n"
```

### Offload flow

1. Caller calls `sandbox.offload()`
2. Guard: if a `run()` is in progress, throw `Error: cannot offload while a command is running`
3. `sandbox.exportState()` → `Uint8Array` blob (user files + env + history)
4. Call `storage.save(sandboxId, blob)` — consumer stores it
5. Clear VFS user file content: walk the inode tree and set each file's `content` to an empty `Uint8Array`. This frees the `Uint8Array` buffers that hold file data.
6. Set `sandbox.offloaded = true`
7. Any `run()`, `readFile()`, `writeFile()`, etc. while offloaded throws: `Error: sandbox is offloaded — call rehydrate() first`

### Rehydrate flow

1. Caller calls `sandbox.rehydrate()`
2. Call `storage.load(sandboxId)` → consumer returns the blob
3. `sandbox.importState(blob)` → restores file contents, env, history
4. Set `sandbox.offloaded = false`
5. Execution resumes normally — the shell runner was never destroyed

### Lifecycle states

```
active  →  offload()    →  offloaded
                                ↓
active  ←  rehydrate()  ←  offloaded
```

The `offloaded` flag is checked in `assertAlive()` (which already guards all public methods).

### VFS content clearing

After `exportState()` and `storage.save()`, we need to clear the file content to actually free memory. The VFS stores files as inodes with a `content: Uint8Array` field. We walk the inode tree and replace each file's content with `new Uint8Array(0)`, setting size to 0. The directory structure and metadata (names, permissions, timestamps) are preserved — only the file data buffers are freed.

This is a new method on VFS: `clearFileContents()`. It walks the tree and zeros out file inodes.

### Python ↔ SDK server wire protocol

Uses the existing bidirectional JSON-RPC callback mechanism:

**Offload:**
1. Python sends: `{"jsonrpc": "2.0", "id": 5, "method": "offload", "params": {"sandboxId": "..."}}`
2. Server calls `sandbox.exportState()` → base64 encodes the blob
3. Server sends callback: `{"jsonrpc": "2.0", "id": "cb_3", "method": "storage.save", "params": {"sandbox_id": "...", "state": "<base64>"}}`
4. Python handler decodes and stores, responds with result
5. Server clears VFS content, marks offloaded, responds to original request

**Rehydrate:**
1. Python sends: `{"jsonrpc": "2.0", "id": 6, "method": "rehydrate", "params": {"sandboxId": "..."}}`
2. Server sends callback: `{"jsonrpc": "2.0", "id": "cb_4", "method": "storage.load", "params": {"sandbox_id": "..."}}`
3. Python handler loads blob, responds with base64 data
4. Server decodes, calls `importState()`, marks active, responds

**Size considerations:** The blob is base64-encoded for JSON-RPC transport. For a sandbox with 10MB of user files, the base64 string is ~13MB. The default `maxLineBytes` limit in the SDK server is 8MB. When storage callbacks are configured, the server should bump this limit (or the `offload`/`rehydrate` methods should use a separate transport). For v1, we document a practical limit and bump `maxLineBytes` when storage is configured.

### Error handling

- `offload()` when already offloaded: no-op (idempotent)
- `rehydrate()` when already active: no-op (idempotent)
- `offload()` without storage callbacks: throws `Error: no storage callbacks configured`
- `rehydrate()` without storage callbacks: throws `Error: no storage callbacks configured`
- `offload()` while a command is running: throws `Error: cannot offload while a command is running`
- `storage.save()` throws: `offload()` propagates the error, sandbox remains active (state not cleared)
- `storage.load()` throws: `rehydrate()` propagates the error, sandbox remains offloaded
- `destroy()` on an offloaded sandbox: cleans up remaining infrastructure, no error

### Forked sandboxes

After `fork()`, the child gets a CoW clone of the VFS — it's fully independent. Offloading a parent does not affect forked children. Offloading a forked child works the same as any sandbox.

## Changes

### `packages/orchestrator/src/vfs/vfs.ts`
- Add `clearFileContents()` method: walks inode tree, sets file content to empty Uint8Array

### `packages/orchestrator/src/sandbox.ts`
- Add `StorageCallbacks` interface (exported)
- Add `storage?: StorageCallbacks` to create options
- Add `offloaded: boolean` flag
- Add `offload()` method: guard → exportState → save callback → clearFileContents → mark offloaded
- Add `rehydrate()` method: load callback → importState → mark active
- Extend `assertAlive()` to check offloaded state
- Store `storage` callbacks on the instance

### `packages/sdk-server/src/dispatcher.ts`
- Add `offload` RPC method
- Add `rehydrate` RPC method
- Update `SandboxLike` interface with `offload()` and `rehydrate()`
- Track offloaded state per sandbox (or delegate to sandbox instance)

### `packages/sdk-server/src/server.ts`
- Bump `maxLineBytes` when storage callbacks are configured
- Route `storage.save`/`storage.load` callback requests

### `packages/python-sdk/src/codepod/_rpc.py`
- Handle `storage.save` and `storage.load` callback methods in `_handle_callback()`

### `packages/python-sdk/src/codepod/sandbox.py` (or equivalent entry point)
- Add `storage` parameter to `Sandbox.__init__`
- Register save/load handlers with RPC client
- Add `offload()` and `rehydrate()` methods

## What this does NOT include

- **Automatic eviction** — no TTL, no memory pressure detection. The consumer decides when to offload.
- **MCP changes** — MCP already has `export_state`/`import_state` tools.
- **Pool-level offloading** — individual sandbox level only.
- **Chunked transfer** — full blob as single base64 string. Document practical size limit (~10MB of user files).
- **Runner teardown** — the shell runner, WASM modules, and config files stay alive. Only file content is freed.

## Testing

### TypeScript
- Round-trip: write file → offload → rehydrate → read file → matches
- Run while offloaded: throws error with clear message
- Offload without storage: throws
- Double offload is idempotent
- Double rehydrate is idempotent
- Storage.save failure: sandbox remains active, no content cleared
- Offload during active run: throws
- Env vars survive round-trip
- Multiple offload/rehydrate cycles with modifications between

### Python
- Same round-trip test via Python SDK
- Verify callback protocol (storage.save/storage.load callbacks fire)
- Verify base64 encoding/decoding
