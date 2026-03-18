# Sandbox Pooling & Multi-Sandbox SDK Server

**Date:** 2026-03-18
**Status:** Draft
**Scope:** `packages/orchestrator`, `packages/mcp-server`, `packages/sdk-server`, `packages/python-sdk`

## Motivation

Sandbox creation involves several expensive operations: WASM module compilation (~100-200ms first time), VFS bootstrap (directory tree, tool registration via `scanTools()`), module preloading, and Python shim injection. For applications that create sandboxes frequently (MCP server with LLM agents, SDK server with per-user sandboxes), this cold-start cost adds up.

OpenSandbox (Alibaba) validates this pattern with their `BatchSandbox` CRD and client-side pooling proposal. We can achieve the same benefit within codepod's WASM architecture.

Additionally, the SDK server currently supports only a single root sandbox with fork. Promoting it to multi-sandbox support aligns it with the MCP server's capability and enables applications that manage multiple user sessions from a single process.

## Design

### 1. SandboxPool (Orchestrator)

New class at `packages/orchestrator/src/pool/sandbox-pool.ts`.

```typescript
interface PoolConfig {
  minSize: number;          // Minimum idle sandboxes to maintain
  maxSize: number;          // Cap on total sandboxes (idle + creating + checked out)
  replenishIntervalMs?: number;  // Health-check interval, default 1000ms
}

interface CheckoutOptions {
  files?: Array<{ path: string; content: Uint8Array }>;
  env?: Record<string, string>;
  mounts?: MountConfig[];  // Same type as SandboxOptions.mounts
  networkPolicy?: NetworkPolicy;
  label?: string;
  extensions?: Extension[];
}

class SandboxPool {
  constructor(config: PoolConfig, sandboxOptions: SandboxOptions);

  /** Take a pre-initialized sandbox from the pool, apply per-user overrides. */
  checkout(overrides?: CheckoutOptions): Promise<Sandbox>;

  /** Destroy a checked-out sandbox and trigger replenishment. */
  release(sandbox: Sandbox): void;

  /** Destroy all idle and in-flight sandboxes. Idempotent. */
  drain(): Promise<void>;

  /** Current pool state. */
  readonly stats: { idle: number; creating: number; checkedOut: number };
}
```

**Pool type:** Homogeneous, fixed-size. All pool members share the same base `SandboxOptions` (including extensions, packages, pythonPath, security settings). Per-user differentiation happens at checkout via `CheckoutOptions`.

**Sandbox lifecycle in pool:**
1. **Replenish:** `Sandbox.create(sandboxOptions)` called in background. Sandbox stored in idle queue.
2. **Checkout:** Pop from idle queue. Apply `CheckoutOptions` (files, env, mounts, network policy, extra extensions). Return to caller.
3. **Release:** Sandbox is destroyed (not recycled — user state makes it dirty). Replenish triggered if idle < minSize.

**Sandboxes are never recycled.** User files, env vars, and mounts make a used sandbox unsuitable for another user. The pool only holds fresh, never-used instances.

### 2. Checkout Sequence

```
checkout(overrides) →
  1. Increment checkedOut counter synchronously (before any await — prevents maxSize races)
  2. Pop sandbox from idle queue (or Sandbox.create() if empty — no blocking)
  3. Apply env vars via sandbox.setEnv() for each key (public API)
  4. Write files via sandbox.writeFile() (public API)
  5. Attach mounts via sandbox.mount(mc.path, mc.files) for each MountConfig
     Note: sandbox.mount() does not support the `writable` option — checkout-time
     mounts are always read-only. Writable mounts must be specified in base SandboxOptions.
  6. Apply network policy (if provided, replaces base policy)
  7. Register extra extensions (host commands + Python packages)
  8. Return personalized sandbox
     (on failure at any step: decrement checkedOut, destroy sandbox, propagate error)
```

All checkout operations are cheap — in-memory VFS writes, Map insertions, no WASM compilation. The expensive shared work (module compilation, coreutils registration, Python shims) was completed during pool replenishment.

### 3. Replenishment Strategy

- Pool starts by creating `minSize` sandboxes serially on initialization (same as replenishment — avoids memory spikes at startup).
- After each checkout or release, if `idle < minSize`, background replenish is triggered.
- Replenish creates sandboxes **one at a time** to avoid memory spikes.
- A periodic timer (`replenishIntervalMs`, default 1000ms) checks pool health as a safety net.
- `maxSize` caps total sandboxes across all states: `idle + creating + checkedOut <= maxSize`.
- In-flight creates are tracked in the `creating` counter. Fallback creates in `checkout()` also increment `checkedOut` synchronously before the `await` to prevent races between concurrent checkout calls.

**Error handling:**
- Failed creation during replenish: log error, wait `replenishIntervalMs`, retry on next tick. Do not crash the pool.
- Failed creation during fallback `checkout()`: propagate error to caller (same as current behavior).
- `drain()` is idempotent — safe to call multiple times.

**Memory budget per idle sandbox:**
- Compiled WASM modules: shared via NodeAdapter static cache, ~0 marginal cost per sandbox.
- VFS inode tree: ~50KB (default directory structure + tool stubs).
- ProcessManager tool map: ~5KB.
- Python shims: ~10KB.
- **Total: ~65KB per idle sandbox.** Pool of 10 = ~650KB.

### 4. SDK Server Multi-Sandbox Upgrade

Currently the SDK server (`packages/sdk-server/`) creates one root sandbox on the first `create` RPC and supports `sandbox.fork()` for up to 16 children.

**New RPC methods added to Dispatcher:**

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `sandbox.create` | `{ label? }` | `{ sandboxId }` | Checkout from pool (or direct create) |
| `sandbox.list` | none | `[{ sandboxId, label, createdAt }]` | List all active sandboxes |
| `sandbox.remove` | `{ sandboxId }` | `{ ok: true }` | Release sandbox back to pool |

Note: the new method is `sandbox.remove`, not `sandbox.destroy`. The existing `sandbox.destroy` method in the dispatcher already handles fork destruction with different semantics. Both methods coexist: `sandbox.destroy` destroys a forked child, `sandbox.remove` releases a top-level sandbox (and pool-checked-out sandboxes).

**Changed behavior:**
- The first `create` RPC initializes the server (and optionally the pool). It no longer creates a sandbox itself.
- All sandboxes are created via `sandbox.create` — no special root sandbox.
- `kill()` destroys all sandboxes, drains the pool, then exits.
- Existing `sandboxId?` params on `run`, `files.*`, `snapshot.*`, `env.*` etc. continue to work unchanged. The dispatcher's `resolveSandbox()` method is updated to check a new `this.sandboxes: Map<string, SandboxLike>` registry in addition to `this.forks`. Lookup order: `sandboxes` first, then `forks`. Top-level sandboxes (from `sandbox.create`) go into `this.sandboxes`; forked children go into `this.forks` as before.
- `sandbox.fork()` works on any sandbox, not just a root.
- Max concurrent sandboxes configurable (default 64).

**Pool configuration in SDK server:**
- Optional `pool` field in the `create` RPC params:
  ```json
  { "method": "create", "params": { "pool": { "minSize": 3, "maxSize": 10 }, ...otherOptions } }
  ```
- If `pool` provided, SDK server creates a `SandboxPool` and uses it for all `sandbox.create` calls.
- If no `pool` provided, `sandbox.create` falls back to direct `Sandbox.create()`.

**Backward compatibility:**
- The existing `create` RPC continues to initialize the server exactly as before.
- If a client sends `run` (no sandboxId) without first calling `sandbox.create`, the server auto-creates a default sandbox using base `SandboxOptions` (same as what the old `create` RPC did). This sandbox gets a well-known sandboxId `"default"` and is reused for all subsequent no-sandboxId calls. This preserves the current single-sandbox behavior for existing clients.
- `sandbox.destroy` for forks is unchanged.

### 5. MCP Server Integration

Changes to `packages/mcp-server/src/index.ts`:

- `create_sandbox` tool calls `pool.checkout()` instead of `Sandbox.create()` when pool is configured.
- `destroy_sandbox` tool calls `pool.release()` instead of `sandbox.destroy()`.
- Pool config comes from CLI args (`--pool-min`, `--pool-max`) or `.mcp.json`:
  ```json
  { "pool": { "minSize": 3, "maxSize": 10 } }
  ```
- If no pool config, behavior is unchanged (direct create/destroy).
- `list_sandboxes` remains unchanged — it lists the server's sandbox registry, not the pool internals.

### 6. Python SDK Multi-Sandbox

Changes to `packages/python-sdk/src/codepod/`:

**New `SandboxManager` class** (accessible as `sb.sandboxes`):

The attribute is `sb.sandboxes` (plural) to avoid collision with the class name `Sandbox` and to clearly indicate it manages multiple sandboxes. It is assigned in `Sandbox.__init__` after the existing `create` RPC completes (server initialization).

```python
class SandboxRef:
    """Handle to a single sandbox, with bound commands/files/env access."""
    sandbox_id: str
    label: str | None
    commands: Commands   # Bound to this sandbox_id
    files: Files         # Bound to this sandbox_id

class SandboxManager:
    def create(self, label: str | None = None) -> SandboxRef:
        """Create a new sandbox (checks out from pool if configured).
        Returns a SandboxRef with its own .commands and .files bound to the new sandboxId."""

    def list(self) -> list[SandboxInfo]:
        """List all active sandboxes."""

    def remove(self, sandbox_id: str) -> None:
        """Release a sandbox (matches sandbox.remove RPC)."""
```

`SandboxRef` follows the same pattern as the current `fork()` implementation — each ref has its own `Commands` and `Files` instances bound to the specific `sandboxId`.

**Usage:**
```python
with Sandbox(pool=PoolConfig(min_size=3, max_size=10)) as sb:
    s1 = sb.sandboxes.create(label="user-alice")
    s2 = sb.sandboxes.create(label="user-bob")

    s1.commands.run("echo hi")          # Routed to s1's sandbox
    s2.files.write("/data.txt", b"hello")  # Routed to s2's sandbox

    sb.sandboxes.list()
    sb.sandboxes.remove(s1.sandbox_id)
```

**Backward compatibility:** The existing `Sandbox.__init__` continues to call the `create` RPC for server initialization. If `sb.sandboxes.create()` is never called, the server auto-creates a default sandbox on first command (via the SDK server backward compatibility described in Section 4) — identical to current behavior. The existing `sb.commands`, `sb.files` etc. work unchanged when no `sandbox_id` is passed.

### 7. File Layout

```
packages/orchestrator/src/pool/
  sandbox-pool.ts           # SandboxPool class
  types.ts                  # PoolConfig, CheckoutOptions interfaces
  index.ts                  # Re-exports

packages/orchestrator/src/pool/__tests__/
  sandbox-pool.test.ts      # Unit tests

packages/sdk-server/src/
  dispatcher.ts             # Extended with sandbox.create/list/remove methods + resolveSandbox() update
  server.ts                 # Pool initialization on create RPC

packages/mcp-server/src/
  index.ts                  # Pool integration in create_sandbox/destroy_sandbox
  config.ts                 # Pool CLI args and .mcp.json parsing

packages/python-sdk/src/codepod/
  sandbox.py                # PoolConfig param, auto-create compat, sb.sandboxes attr
  sandbox_manager.py        # New SandboxManager class (sb.sandboxes namespace)
```

## Testing

**Unit tests** (`packages/orchestrator/src/pool/__tests__/sandbox-pool.test.ts`):
- Pool initializes to `minSize` sandboxes
- `checkout()` returns a working sandbox, idle count decreases
- `checkout()` on empty pool falls back to direct create
- `release()` destroys sandbox, triggers replenish
- `drain()` cleans up all idle and in-flight sandboxes
- `maxSize` cap respected (idle + creating + checkedOut <= maxSize)
- `CheckoutOptions` (files, env, mounts, extensions) applied correctly
- Failed creation during replenish does not crash pool

**Integration tests** (MCP server, SDK server):
- MCP `create_sandbox` uses pool when configured, direct create when not
- SDK server `sandbox.create` RPC works with and without pool
- SDK server multi-sandbox lifecycle: create -> run -> destroy
- Python SDK `sb.sandboxes.create()` / `sb.sandboxes.list()` / `sb.sandboxes.remove()`
- Backward compatibility: existing single-sandbox usage unchanged in both servers
- Auto-create default sandbox on first no-sandboxId `run` call

**Test commands:**
```bash
deno test -A --no-check packages/orchestrator/src/pool/**/*.test.ts
deno test -A --no-check packages/mcp-server/src/*.test.ts
deno test -A --no-check packages/sdk-server/src/*.test.ts
cd packages/python-sdk && pytest
```

## Non-Goals

- **Sandbox recycling:** Dirty sandboxes are destroyed, not cleaned and returned.
- **Heterogeneous pools:** One config per pool. Different configs need different pools.
- **Adaptive sizing:** Fixed min/max for now. Demand-based scaling is a follow-up.
- **Snapshot-based warm restart:** Pool rebuilds from scratch on server restart.
- **Cross-process pooling:** Each server process has its own pool.
