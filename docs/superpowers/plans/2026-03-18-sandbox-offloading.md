# Sandbox Offloading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `offload()` and `rehydrate()` methods to the Sandbox class so consumers can save inactive sandbox state to external storage and restore it later, freeing VFS file content memory.

**Architecture:** Offloading exports state via the existing `exportState()` serializer, passes it to a consumer-provided `save` callback, then clears VFS file content buffers. Rehydrating calls the consumer's `load` callback, then `importState()`. The shell runner, WASM modules, and config files stay alive — only file content is freed.

**Tech Stack:** TypeScript (Deno), Python 3, JSON-RPC 2.0 callbacks.

**Spec:** `docs/superpowers/specs/2026-03-18-sandbox-offloading-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/orchestrator/src/vfs/vfs.ts` | Modify | Add `clearFileContents()` method |
| `packages/orchestrator/src/sandbox.ts` | Modify | Add `StorageCallbacks`, `offloaded` flag, `offload()`, `rehydrate()` |
| `packages/orchestrator/src/__tests__/offloading.test.ts` | Create | TypeScript offloading tests |
| `packages/sdk-server/src/dispatcher.ts` | Modify | Add `offload`/`rehydrate` RPC methods, update `SandboxLike` |
| `packages/python-sdk/src/codepod/_rpc.py` | Modify | Handle `storage.save`/`storage.load` callbacks |
| `packages/python-sdk/src/codepod/sandbox.py` | Modify | Add `storage` param, `offload()`, `rehydrate()` |

---

### Task 1: Add `clearFileContents()` to VFS

**Files:**
- Modify: `packages/orchestrator/src/vfs/vfs.ts`

- [ ] **Step 1: Add the method**

In `packages/orchestrator/src/vfs/vfs.ts`, add a new public method to the `VFS` class. Place it near the existing `cowClone()` or `snapshot()` methods:

```typescript
  /** Clear all file content buffers to free memory. Directory structure and metadata are preserved. */
  clearFileContents(): void {
    const walk = (node: DirInode): void => {
      for (const child of node.children.values()) {
        if (child.type === 'file') {
          this.totalBytes -= child.content.byteLength;
          child.content = new Uint8Array(0);
        } else if (child.type === 'dir') {
          walk(child);
        }
      }
    };
    walk(this.root);
  }
```

Note: `this.totalBytes` tracks VFS size for quota enforcement. We must decrement it as we clear content, otherwise `importState()` writes will hit ENOSPC. Import the `DirInode` type if not already in scope (check existing imports).

- [ ] **Step 2: Commit**

```bash
git add packages/orchestrator/src/vfs/vfs.ts
git commit -m "feat(vfs): add clearFileContents() for sandbox offloading"
```

---

### Task 2: Add `offload()` and `rehydrate()` to Sandbox

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`

- [ ] **Step 1: Add `StorageCallbacks` interface and `offloaded` flag**

Near the top of `packages/orchestrator/src/sandbox.ts`, after the existing `StreamCallbacks` export, add:

```typescript
/** Callbacks for offloading sandbox state to external storage. */
export interface StorageCallbacks {
  save: (sandboxId: string, state: Uint8Array) => Promise<void>;
  load: (sandboxId: string) => Promise<Uint8Array>;
}
```

Add to the `Sandbox` class properties (near line 99, after `private destroyed = false;`):

```typescript
  private offloaded = false;
  private storage: StorageCallbacks | null = null;
  private running = false;
```

- [ ] **Step 2: Store `storage` callbacks from create options**

In `Sandbox.create()`, the options are passed as the first argument. Find where the `Sandbox` constructor is called (near the end of `create()`). We need to pass `storage` through.

Add `storage?: StorageCallbacks` to the `SandboxOptions` type (find it in the same file or wherever create options are typed). Then in the constructor, store it:

```typescript
    this.storage = parts.storage ?? null;
```

Update `SandboxParts` to include `storage?: StorageCallbacks`.

- [ ] **Step 3: Update `assertAlive()` to check offloaded state**

Replace the existing `assertAlive()` (line 744):

```typescript
  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('Sandbox has been destroyed');
    }
    if (this.offloaded) {
      throw new Error('Sandbox is offloaded — call rehydrate() first');
    }
  }
```

- [ ] **Step 4: Add `offload()` method**

Add after the `importState()` method:

```typescript
  /** Offload sandbox state to external storage, freeing VFS file content memory. */
  async offload(): Promise<void> {
    if (this.offloaded) return; // idempotent
    if (this.destroyed) throw new Error('Sandbox has been destroyed');
    if (!this.storage) throw new Error('No storage callbacks configured');
    if (this.running) throw new Error('Cannot offload while a command is running');

    const blob = this.exportState();
    await this.storage.save(this.sessionId, blob);
    this.vfs.clearFileContents();
    this.offloaded = true;
  }
```

- [ ] **Step 5: Add `rehydrate()` method**

```typescript
  /** Restore sandbox state from external storage. */
  async rehydrate(): Promise<void> {
    if (!this.offloaded) return; // idempotent
    if (this.destroyed) throw new Error('Sandbox has been destroyed');
    if (!this.storage) throw new Error('No storage callbacks configured');

    const blob = await this.storage.load(this.sessionId);
    this.offloaded = false; // clear before importState so assertAlive passes
    this.importState(blob);
  }
```

- [ ] **Step 6: Guard `run()` with `running` flag**

In the `run()` method, wrap the execution in a `running` flag. After `this.assertAlive();` add:

```typescript
    this.running = true;
```

And at the end of `run()`, before the final `return result;`:

```typescript
    this.running = false;
```

Also wrap in try/finally to ensure cleanup:

```typescript
    this.running = true;
    try {
      // ... existing execution code ...
    } finally {
      this.running = false;
    }
```

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts
git commit -m "feat(sandbox): add offload() and rehydrate() with storage callbacks"
```

---

### Task 3: TypeScript offloading tests

**Files:**
- Create: `packages/orchestrator/src/__tests__/offloading.test.ts`

- [ ] **Step 1: Create test file**

```typescript
/**
 * Integration tests for sandbox offloading and rehydration.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('Sandbox offloading', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;
  const blobs = new Map<string, Uint8Array>();

  const storage = {
    save: async (id: string, state: Uint8Array) => { blobs.set(id, state); },
    load: async (id: string) => {
      const blob = blobs.get(id);
      if (!blob) throw new Error('not found');
      return blob;
    },
  };

  afterEach(() => {
    sandbox?.destroy();
    blobs.clear();
  });

  it('offload and rehydrate preserves files', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await sandbox.offload();
    expect(blobs.size).toBe(1);

    await sandbox.rehydrate();
    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('hello');
  });

  it('offload and rehydrate preserves env vars', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.setEnv('FOO', 'bar');

    await sandbox.offload();
    await sandbox.rehydrate();

    const result = await sandbox.run('echo $FOO');
    expect(result.stdout.trim()).toBe('bar');
  });

  it('run while offloaded throws', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    await sandbox.offload();

    await expect(sandbox.run('echo hello')).rejects.toThrow('offloaded');
  });

  it('readFile while offloaded throws', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    await sandbox.offload();

    expect(() => sandbox.readFile('/tmp/test.txt')).toThrow('offloaded');
  });

  it('offload without storage throws', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    await expect(sandbox.offload()).rejects.toThrow('No storage callbacks configured');
  });

  it('double offload is idempotent', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await sandbox.offload();
    const blobCount = blobs.size;
    await sandbox.offload(); // should be a no-op
    expect(blobs.size).toBe(blobCount);
  });

  it('double rehydrate is idempotent', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await sandbox.offload();
    await sandbox.rehydrate();
    await sandbox.rehydrate(); // should be a no-op

    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('hello');
  });

  it('save failure keeps sandbox active', async () => {
    const failStorage = {
      save: async () => { throw new Error('storage down'); },
      load: async () => new Uint8Array(0),
    };
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage: failStorage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await expect(sandbox.offload()).rejects.toThrow('storage down');
    // Sandbox should still be active
    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('hello');
  });

  it('multiple offload/rehydrate cycles work', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('v1'));

    await sandbox.offload();
    await sandbox.rehydrate();

    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('v2'));
    await sandbox.offload();
    await sandbox.rehydrate();

    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('v2');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/offloading.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/__tests__/offloading.test.ts
git commit -m "test(offloading): add TypeScript sandbox offloading tests"
```

---

### Task 4: SDK server offload/rehydrate RPC methods

**Files:**
- Modify: `packages/sdk-server/src/dispatcher.ts`

- [ ] **Step 1: Update `SandboxLike` interface**

Add to the `SandboxLike` interface (around line 10):

```typescript
  offload(): Promise<void>;
  rehydrate(): Promise<void>;
  readonly sessionId: string;
```

- [ ] **Step 2: Add `offload` RPC method**

In the Dispatcher class, add a new method:

```typescript
  private async offload(params: Record<string, unknown>, requestId?: number | string) {
    const sb = this.resolveSandbox(params);

    // Export state
    const blob = sb.exportState();
    const data = this.base64Encode(blob);

    // Call Python's storage.save via callback
    await this.sendCallback('storage.save', {
      sandbox_id: this.resolveSandboxId(params),
      state: data,
    });

    // Offload locally
    await sb.offload();
    return null;
  }
```

Wait — actually the `offload()` method on Sandbox already handles the full flow (export → save callback → clear). The SDK server shouldn't duplicate that logic. But the problem is the storage callbacks need to bridge to Python via JSON-RPC callbacks.

Better approach: The SDK server creates `StorageCallbacks` that bridge to Python callbacks when creating the sandbox. Then `offload()`/`rehydrate()` on the Sandbox instance automatically route through the bridge.

- [ ] **Step 2 (revised): Bridge storage callbacks in sandbox creation**

When the Python SDK sends `create` with storage configuration, the SDK server constructs `StorageCallbacks` that use `sendCallback` to relay to Python:

In the server's sandbox creation code, after creating the sandbox, if the create params include `storage: true`, set up the callbacks:

```typescript
const storageCallbacks = params.storage ? {
  save: async (sandboxId: string, state: Uint8Array) => {
    const data = Buffer.from(state).toString('base64');
    await sendCallback('storage.save', { sandbox_id: sandboxId, state: data });
  },
  load: async (sandboxId: string) => {
    const result = await sendCallback('storage.load', { sandbox_id: sandboxId });
    return new Uint8Array(Buffer.from(result as string, 'base64'));
  },
} : undefined;
```

Pass `storageCallbacks` as the `storage` option to `Sandbox.create()`.

- [ ] **Step 3: Add `offload`/`rehydrate` RPC methods to dispatcher**

These are simple pass-throughs since the Sandbox class handles the full flow:

```typescript
  private async offload(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    await sb.offload();
    return null;
  }

  private async rehydrate(params: Record<string, unknown>) {
    const sb = this.resolveSandbox(params);
    await sb.rehydrate();
    return null;
  }
```

Add them to the dispatch router (wherever method names are mapped to handlers).

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-server/src/dispatcher.ts packages/sdk-server/src/server.ts
git commit -m "feat(sdk-server): add offload/rehydrate RPC methods with storage callback bridge"
```

---

### Task 5: Python SDK offloading support

**Files:**
- Modify: `packages/python-sdk/src/codepod/_rpc.py`
- Modify: `packages/python-sdk/src/codepod/sandbox.py`

- [ ] **Step 1: Handle storage callbacks in `_rpc.py`**

In `_rpc.py`, update `_handle_callback()` to handle `storage.save` and `storage.load` methods. Add a `_storage_handlers` dict to `__init__`:

```python
self._storage_handlers: dict[str, Callable] = {}
```

Add a registration method:

```python
def register_storage_handlers(self, save: "Callable | None", load: "Callable | None") -> None:
    if save:
        self._storage_handlers["storage.save"] = save
    if load:
        self._storage_handlers["storage.load"] = load
```

In `_handle_callback()`, add a branch for storage methods:

```python
elif method in ("storage.save", "storage.load"):
    handler = self._storage_handlers.get(method)
    if handler is None:
        self._send_callback_error(cb_id, f"No handler for: {method}")
        return
    if method == "storage.save":
        import base64
        state = base64.b64decode(params.get("state", ""))
        handler(params.get("sandbox_id", ""), state)
        self._send_callback_result(cb_id, None)
    elif method == "storage.load":
        import base64
        result = handler(params.get("sandbox_id", ""))
        data = base64.b64encode(result).decode("ascii")
        self._send_callback_result(cb_id, data)
```

- [ ] **Step 2: Add `storage` param and methods to `sandbox.py`**

In `packages/python-sdk/src/codepod/sandbox.py`, update `Sandbox.__init__` to accept `storage`:

Add parameter:
```python
storage: "dict[str, Callable] | None" = None,
```

After `self._client.start()`, register storage handlers:
```python
if storage:
    self._client.register_storage_handlers(
        save=storage.get("save"),
        load=storage.get("load"),
    )
```

Pass `storage: True` in the create params:
```python
if storage:
    create_params["storage"] = True
```

Add methods:
```python
def offload(self) -> None:
    """Offload sandbox state to external storage, freeing memory."""
    self._client.call("offload", self._with_id({}))

def rehydrate(self) -> None:
    """Restore sandbox state from external storage."""
    self._client.call("rehydrate", self._with_id({}))
```

- [ ] **Step 3: Commit**

```bash
git add packages/python-sdk/src/codepod/_rpc.py packages/python-sdk/src/codepod/sandbox.py
git commit -m "feat(python-sdk): add storage callbacks and offload/rehydrate support"
```

---

### Task 6: Run full test suite

- [ ] **Step 1: Run offloading tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/offloading.test.ts`
Expected: All pass.

- [ ] **Step 2: Run all TypeScript tests**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/offloading.test.ts packages/orchestrator/src/__tests__/streaming.test.ts packages/orchestrator/src/__tests__/wasi-syscalls.test.ts packages/orchestrator/src/__tests__/sandbox.test.ts`
Expected: All pass (existing ENOSPC failure is pre-existing).

- [ ] **Step 3: Commit fixups if needed**

```bash
git add -u
git commit -m "fix(offloading): address test failures"
```
