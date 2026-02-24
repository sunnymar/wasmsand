# VFS Mount System Design

## Goal

Allow hosts to inject files into the sandbox VFS at arbitrary mount paths. This enables three primary use cases:

1. **Tools directory** — mount a `/mnt/tools` dir populated with scripts/tools the LLM can use
2. **Chat uploads** — mount user-uploaded files so they're automatically accessible inside the sandbox
3. **Python libraries** — mount packages at paths added to PYTHONPATH (e.g. custom modules, tinynumpy)

## Architecture

```
Host Application
    │
    │  mount("/mnt/tools", { "hello.sh": bytes, ... })
    │  mount("/mnt/libs", myVirtualFS)
    │
    ▼
┌──────────────────────────────────────────────┐
│  Sandbox                                      │
│                                               │
│  ┌────────────────────────────────────────┐  │
│  │  VFS (inode tree)                       │  │
│  │                                         │  │
│  │  /                                      │  │
│  │  ├── home/user/          (writable)     │  │
│  │  ├── tmp/                (writable)     │  │
│  │  ├── mnt/                               │  │
│  │  │   ├── tools/   ← HostMount provider  │  │
│  │  │   └── libs/    ← HostMount provider  │  │
│  │  ├── dev/         ← DevProvider         │  │
│  │  └── proc/        ← ProcProvider        │  │
│  └────────────────────────────────────────┘  │
│                                               │
│  Provider dispatch: path → VirtualProvider    │
│  matchProvider("/mnt/tools/hello.sh")         │
│    → { provider: HostMount, subpath: "hello.sh" } │
└──────────────────────────────────────────────┘
```

## Design Decisions

### Provider vs. file injection

We chose a **VirtualProvider-based** approach rather than writing files directly into the VFS inode tree:

- **Isolation** — mounted files live in a separate tree managed by the provider, not the VFS's inode system. This means they don't count against `fsLimitBytes` or `fileCount` limits.
- **Exclusion from persistence** — provider paths are automatically excluded from `exportState()`. Mounted files are host-provided, not sandbox-produced state.
- **Fork semantics** — providers are shared by reference in `cowClone()`. Built-in providers (`/dev`, `/proc`) get fresh instances; user mounts share the same `HostMount`. This is safe because user mounts are typically read-only.

### Visible vs. invisible mounts

Existing providers (`/dev`, `/proc`) are "invisible" — their mount points don't appear as directory nodes in the parent inode tree. They intercept path resolution but aren't listed by `readdir('/')`.

User mounts use `VFS.mount()` which creates a real directory node in the inode tree AND registers the provider. This means `ls /mnt` shows `tools` — the mount point is visible in directory listings, which is essential for discoverability.

### Static snapshot model (Python SDK)

The Python VFS bridge uses a **snapshot-at-mount-time** model rather than callback-based proxying:

```
Python Host                    Bun/Node Subprocess
    │                               │
    │  mount("/mnt/x", myFS)        │
    │  → _to_flat_files()           │
    │  → base64-encode all files    │
    │  → JSON-RPC: mount(path,files)│
    │  ─────────────────────────────>
    │                               │  new HostMount(decoded_files)
    │                               │  vfs.mount("/mnt/x", provider)
    │                               │
    │  run("cat /mnt/x/file.txt")   │
    │  ─────────────────────────────>
    │                               │  WASM reads from HostMount
    │  <─────────────────────────────
    │  result                        │
```

**Why not callback-based?** The `VirtualProvider` interface is synchronous (`readFile(subpath): Uint8Array`). During WASM execution, file reads happen synchronously in the WASI host. Making these async to call back to Python over stdin/stdout would require either:
- `SharedArrayBuffer` + `Atomics.wait()` (Node-only, requires cross-origin isolation in browser)
- Changing `VirtualProvider` to async (massive refactor touching VFS, WASI host, and all providers)

The snapshot model is simple, correct, and sufficient for the target use cases (tools, uploads, small libraries).

## Components

### HostMount (orchestrator)

`packages/orchestrator/src/vfs/host-mount.ts`

In-memory file tree implementing `VirtualProvider`. Constructed from a flat `Record<string, Uint8Array>` where keys like `'lib/__init__.py'` auto-create intermediate directory nodes.

```typescript
interface HostMountOptions {
  writable?: boolean;  // default false
}

class HostMount implements VirtualProvider {
  constructor(files: Record<string, Uint8Array>, options?: HostMountOptions);
  addFile(subpath: string, data: Uint8Array): void;
  // VirtualProvider methods:
  readFile(subpath: string): Uint8Array;
  writeFile(subpath: string, data: Uint8Array): void;
  exists(subpath: string): boolean;
  stat(subpath: string): { type: 'file' | 'dir'; size: number };
  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }>;
}
```

Internal tree structure: `DirNode { children: Map<string, Node> }` / `FileNode { data: Uint8Array }`. A private `resolve(subpath)` helper splits on `/` and walks the tree.

### VFS extensions

`packages/orchestrator/src/vfs/vfs.ts`

- **`mount(path, provider)`** — creates directory node in inode tree (visible in `ls`) then registers the provider
- **`getProviderPaths()`** — returns all provider mount paths for persistence exclusion
- **`fromRoot()` fix** — carries forward user-mounted providers by reference in `cowClone()`; only `/dev` and `/proc` get fresh instances

### Sandbox extensions

`packages/orchestrator/src/sandbox.ts`

```typescript
interface MountConfig {
  path: string;
  files: Record<string, Uint8Array>;
  writable?: boolean;
}

interface SandboxOptions {
  // ... existing options ...
  mounts?: MountConfig[];
  pythonPath?: string[];
}

class Sandbox {
  mount(path: string, filesOrProvider: Record<string, Uint8Array> | VirtualProvider): void;
}
```

- `mounts` processed in `Sandbox.create()` before `ShellRunner` init
- `pythonPath` sets `PYTHONPATH` to `[...userPaths, '/usr/lib/python'].join(':')`
- `exportState()` passes `vfs.getProviderPaths()` as excluded paths to the serializer

### Persistence exclusion

`packages/orchestrator/src/persistence/serializer.ts`

`exportState()` accepts optional `excludePaths` parameter (default: `['/dev', '/proc']`). The sandbox passes all provider paths, so user mounts like `/mnt/tools` are excluded alongside virtual providers.

### Python VFS (Python SDK)

`packages/python-sdk/src/wasmsand/vfs.py`

```python
class VirtualFileSystem(ABC):
    """Mirrors the TypeScript VirtualProvider interface."""
    def read_file(self, path: str) -> bytes: ...
    def write_file(self, path: str, data: bytes) -> None: ...
    def exists(self, path: str) -> bool: ...
    def stat(self, path: str) -> FileStat: ...
    def readdir(self, path: str) -> list[DirEntry]: ...

class MemoryFS(VirtualFileSystem):
    """In-memory implementation from flat dict."""
    def __init__(self, files: dict[str, bytes | str], *, writable: bool = False): ...
```

`VirtualFileSystem` has an internal `_to_flat_files()` method that walks the tree via `readdir()` + `read_file()` and returns a flat `dict[str, bytes]`. This is used to serialize any VFS implementation for RPC transport.

### RPC bridge (SDK server)

`packages/sdk-server/src/dispatcher.ts` / `server.ts`

- **`create` params**: accepts `mounts` (array of `{path, files, writable?}`) and `pythonPath`
- **`mount` RPC method**: receives `{path, files: Record<string, base64>}`, decodes, calls `sandbox.mount()`
- File data is base64-encoded for JSON-RPC transport

## PYTHONPATH integration

When `pythonPath` is provided (or networking is enabled), `PYTHONPATH` is set to:

```
${userPaths.join(':')}:/usr/lib/python
```

`/usr/lib/python` is always included as the final entry because it contains:
- `socket.py` (network shim for RustPython, when networking is enabled)
- `sitecustomize.py` (pre-loads the socket shim)

User paths come first so user-provided modules take priority over system modules.

## Fork behavior

When a sandbox is forked via `cowClone()`:

| Provider type | Fork behavior |
|---------------|---------------|
| `/dev` | Fresh `DevProvider` instance |
| `/proc` | Fresh `ProcProvider` instance (independent uptime, etc.) |
| User mounts | Shared by reference (safe: typically read-only) |

This means forked sandboxes see the same mounted files as the parent. If a mount is writable and modified in the fork, the parent also sees the changes. This is an acceptable tradeoff — writable mounts are rare and users who need isolation can create separate `HostMount` instances.

## Security considerations

- Mounted files bypass VFS size/count limits (they're provider-managed, not inode-managed)
- Writable mounts allow the sandbox to modify host-provided data — use `writable: false` (default) unless the sandbox specifically needs write access
- Mount paths are not validated against writable-path restrictions — the host explicitly chooses to make these paths available
- Mounted content is excluded from state exports, preventing accidental leakage of host data in serialized blobs
