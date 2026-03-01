# State & Persistence

Export and import the full sandbox state (filesystem + environment variables) as an opaque binary blob. Useful for long-running agent workflows that need to survive restarts.

## Persistence modes

| Mode | Behavior |
|------|----------|
| `ephemeral` (default) | No persistence, zero overhead |
| `session` | Manual `saveState()`/`loadState()` with auto-detected backend |
| `persistent` | Auto-load on create, debounced auto-save on VFS changes |

## Manual export/import (TypeScript)

```typescript
// Save state
const blob = sandbox.exportState();

// Later, restore into a new sandbox
const sandbox2 = await Sandbox.create({ wasmDir: './wasm' });
sandbox2.importState(blob);
```

## Automatic persistence (TypeScript)

State is automatically saved to IndexedDB (browser) or filesystem (Node) with debounced writes:

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  persistence: { mode: 'persistent', namespace: 'my-agent' },
});

// All VFS changes are auto-saved after a 1s debounce.
// On next create() with the same namespace, state is auto-loaded.
sandbox.writeFile('/tmp/work.txt', new TextEncoder().encode('progress'));

// Clean up persisted state when done
await sandbox.clearPersistedState();
```

## Session mode (TypeScript)

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  persistence: { mode: 'session', namespace: 'my-session' },
});

// Explicitly save and load — no autosave
await sandbox.saveState();
await sandbox.loadState();
```

## Python

### Export/import

```python
# Export/import full state as an opaque binary blob
blob = sb.export_state()

sb2 = Sandbox()
sb2.import_state(blob)
# sb2 now has the same filesystem and environment as sb
```

### Snapshots

Snapshots provide lightweight in-session save points (no serialization overhead):

```python
with Sandbox() as sb:
    sb.files.write("/tmp/original.txt", b"hello")
    snap_id = sb.snapshot()

    sb.files.write("/tmp/original.txt", b"modified")
    sb.restore(snap_id)
    # /tmp/original.txt is back to "hello"
```

### Fork

Fork creates an independent copy of the sandbox (shared RPC server, independent state):

```python
with Sandbox() as sb:
    sb.files.write("/tmp/shared.txt", b"base state")

    fork = sb.fork()
    fork.commands.run("echo fork-only > /tmp/fork.txt")

    # Original sandbox is unaffected
    result = sb.commands.run("cat /tmp/fork.txt")
    assert result.exit_code != 0  # file doesn't exist in parent

    fork.destroy()  # clean up the forked sandbox
```

## Notes

- Virtual filesystems (`/dev`, `/proc`) are excluded from exports — they are regenerated automatically
- Host mounts are excluded from exports — they are host-provided, not sandbox state
- Persistence backends are auto-detected: IndexedDB in the browser, filesystem on Deno/Node.js

## Command history

The shell tracks command history for agent session introspection:

```bash
echo hello
echo world
history list    # shows all executed commands with indices
history clear   # resets history
```

**Python:**

```python
with Sandbox() as sb:
    sb.commands.run("echo hello")
    sb.commands.run("echo world")
    result = sb.commands.run("history list")
    print(result.stdout)  # numbered list of executed commands

    sb.commands.run("history clear")
```

Also available via the RPC API: `shell.history.list`, `shell.history.clear`.
