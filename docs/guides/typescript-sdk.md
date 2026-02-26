# TypeScript SDK Guide

This guide covers the full TypeScript SDK for codepod. For Python, see the [README](../../README.md) or install via `pip install codepod`.

## Installation

```bash
npm install @codepod/sandbox
```

The package includes all WASM binaries in the `wasm/` directory.

## Quick start

```typescript
import { Sandbox } from '@codepod/sandbox';
import { NodeAdapter } from '@codepod/sandbox/node';

const sandbox = await Sandbox.create({
  adapter: new NodeAdapter(),
  wasmDir: './node_modules/@codepod/sandbox/wasm',
});

const result = await sandbox.run('echo hello world | wc -w');
console.log(result.stdout); // "3\n"
console.log(result.exitCode); // 0

sandbox.destroy();
```

In the browser, use `BrowserAdapter`:

```typescript
import { Sandbox } from '@codepod/sandbox';
import { BrowserAdapter } from '@codepod/sandbox/browser';

const sandbox = await Sandbox.create({
  adapter: new BrowserAdapter(),
  wasmDir: '/wasm', // served as static assets
});
```

## Sandbox options

`Sandbox.create()` accepts a `SandboxOptions` object:

```typescript
const sandbox = await Sandbox.create({
  // Required
  wasmDir: './wasm',

  // Platform adapter (auto-detected if omitted)
  adapter: new NodeAdapter(),

  // Per-command timeout in ms (default: 30000)
  timeoutMs: 10_000,

  // Max VFS size in bytes (default: 256MB)
  fsLimitBytes: 128 * 1024 * 1024,

  // Path to shell parser WASM (default: ${wasmDir}/codepod-shell.wasm)
  shellWasmPath: './wasm/codepod-shell.wasm',

  // Network access policy (disabled by default)
  network: { allowedHosts: ['api.example.com'] },

  // Security options
  security: { /* see Security section */ },

  // Persistence configuration
  persistence: { mode: 'ephemeral' },

  // Host file mounts
  mounts: [{ path: '/mnt/tools', files: { 'run.sh': encode('#!/bin/sh\necho hi') } }],

  // Python library paths
  pythonPath: ['/mnt/libs'],
});
```

## Running commands

`sandbox.run()` executes a shell command and returns a `RunResult`:

```typescript
interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
  truncated?: { stdout?: boolean; stderr?: boolean };
}
```

Examples:

```typescript
// Simple command
const { stdout } = await sandbox.run('echo hello');

// Pipes, redirects, control flow
await sandbox.run('for i in 1 2 3; do echo $i; done');
await sandbox.run('cat /tmp/data.csv | sort -t, -k2 -rn | head -5');
await sandbox.run('echo "hello" > /tmp/out.txt && cat /tmp/out.txt');

// Python
await sandbox.run('python3 -c "import json; print(json.dumps({\'x\': 42}))"');

// Check for errors
const result = await sandbox.run('false');
if (result.exitCode !== 0) {
  console.error('Command failed:', result.stderr);
}
```

### Cancellation

Cancel a running command from another async context:

```typescript
const promise = sandbox.run('sleep 60');
setTimeout(() => sandbox.cancel(), 100);

const result = await promise;
// result.exitCode === 124
// result.errorClass === 'CANCELLED'
```

## File operations

Direct access to the virtual filesystem without shell commands:

```typescript
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// Write and read files
sandbox.writeFile('/tmp/data.txt', encode('hello world'));
const content = decode(sandbox.readFile('/tmp/data.txt'));

// Directory operations
sandbox.mkdir('/tmp/subdir');
const entries = sandbox.readDir('/tmp');
// [{ name: 'data.txt', type: 'file' }, { name: 'subdir', type: 'dir' }]

// File metadata
const info = sandbox.stat('/tmp/data.txt');
// { type: 'file', size: 11, permissions: 0o644, mtime: Date, ... }

// Delete
sandbox.rm('/tmp/data.txt');
```

## Environment variables

```typescript
sandbox.setEnv('MY_VAR', 'hello');
const value = sandbox.getEnv('MY_VAR'); // 'hello'

// Available to shell commands
await sandbox.run('echo $MY_VAR'); // stdout: "hello\n"
```

## Host mounts

Mount host-provided files into the sandbox. See the [detailed mounting guide](./mounting-files.md) for full coverage.

### At creation time

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  mounts: [
    {
      path: '/mnt/tools',
      files: {
        'analyze.sh': encode('#!/bin/sh\nwc -l "$1"'),
        'lib/utils.py': encode('def greet(): return "hello"'),
      },
    },
  ],
});
```

### At runtime

```typescript
sandbox.mount('/mnt/uploads', {
  'report.csv': encode('name,score\nalice,95\nbob,87'),
});
```

### Custom VirtualProvider

For dynamic file sources, implement the `VirtualProvider` interface:

```typescript
import type { VirtualProvider } from '@codepod/sandbox';

const dbProvider: VirtualProvider = {
  readFile(subpath: string): Uint8Array {
    // Fetch from database, API, etc.
    return encode(fetchFromDb(subpath));
  },
  writeFile(subpath: string, data: Uint8Array): void {
    throw new Error('read-only');
  },
  exists(subpath: string): boolean {
    return dbHasFile(subpath);
  },
  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    return { type: 'file', size: getFileSize(subpath) };
  },
  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    return listDbFiles(subpath);
  },
};

sandbox.mount('/mnt/db', dbProvider);
```

Or use the built-in `HostMount` class:

```typescript
import { HostMount } from '@codepod/sandbox';

const mount = new HostMount({
  'config.json': encode('{}'),
  'scripts/run.sh': encode('#!/bin/sh\necho hello'),
});

// Add files incrementally
mount.addFile('scripts/extra.sh', encode('#!/bin/sh\necho extra'));

sandbox.mount('/mnt/tools', mount);
```

## Networking

Network access is disabled by default. Enable it with a domain policy:

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  network: {
    // Allowlist mode: only these hosts permitted
    allowedHosts: ['api.example.com', '*.github.com'],

    // Or blocklist mode (ignored if allowedHosts is set):
    // blockedHosts: ['evil.com'],

    // Dynamic callback for fine-grained control
    onRequest: async ({ url, method, headers }) => {
      console.log(`Network request: ${method} ${url}`);
      return true; // allow
    },
  },
});

// curl and wget are now available
await sandbox.run('curl https://api.example.com/data');

// Python networking also works (via socket shim)
await sandbox.run('python3 -c "import urllib.request; print(urllib.request.urlopen(\'https://api.example.com\').read())"');
```

When networking is enabled, a `socket.py` shim is written to `/usr/lib/python` and `PYTHONPATH` is configured automatically.

## Security

Configure resource limits, tool restrictions, and audit logging:

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  security: {
    // Only allow these tools (others return "not allowed by security policy")
    toolAllowlist: ['echo', 'cat', 'grep', 'python3'],

    // Resource limits
    limits: {
      timeoutMs: 5000,          // Per-command timeout (overrides top-level timeoutMs)
      stdoutBytes: 1024 * 1024, // Max stdout per command (default 1MB)
      stderrBytes: 1024 * 1024, // Max stderr per command (default 1MB)
      commandBytes: 65536,      // Max command string length (default 64KB)
      fileCount: 10000,         // Max files in VFS
      memoryBytes: 64 * 1024 * 1024, // Max WASM linear memory
    },

    // Enable hard-kill via Worker thread (Node.js only)
    // Terminates runaway WASM execution on timeout instead of cooperative cancellation
    hardKill: true,

    // Audit event handler
    onAuditEvent: (event) => {
      // event.type: 'sandbox.create', 'command.start', 'command.complete',
      //             'command.timeout', 'limit.exceeded', 'capability.denied', ...
      console.log(`[audit] ${event.type}`, event);
    },

    // Package manager policy
    packagePolicy: {
      enabled: true,
      allowedHosts: ['registry.example.com'],
      maxPackageBytes: 5 * 1024 * 1024,
      maxInstalledPackages: 50,
    },
  },
});
```

### Audit events

| Event type | When |
|------------|------|
| `sandbox.create` | Sandbox created |
| `sandbox.destroy` | Sandbox destroyed |
| `command.start` | Command execution begins |
| `command.complete` | Command finishes (includes `exitCode`) |
| `command.timeout` | Command killed by timeout |
| `command.cancelled` | Command cancelled via `sandbox.cancel()` |
| `limit.exceeded` | Output truncated (`subtype: 'stdout'`/`'stderr'`/`'command'`) |
| `capability.denied` | Tool blocked by allowlist |

### Hard kill

By default, timeouts use cooperative cancellation — the WASM module checks a flag between operations. This works for most code but can't interrupt tight CPU loops.

With `hardKill: true` (Node.js only), commands run in a Worker thread. On timeout, the Worker is terminated immediately — true preemptive kill. VFS changes are synced back via `SharedArrayBuffer`.

## State persistence

### Manual export/import

```typescript
// Export current state (VFS + env vars) as binary blob
const blob = sandbox.exportState();

// Restore into a new sandbox
const sandbox2 = await Sandbox.create({ wasmDir: './wasm' });
sandbox2.importState(blob);
```

Mounted files (from `mounts` or `mount()`) are automatically excluded from exports. Re-mount them when restoring.

### Automatic persistence

```typescript
// Persistent mode: auto-load on create, debounced auto-save on VFS changes
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  persistence: {
    mode: 'persistent',
    namespace: 'my-agent',      // storage key
    autosaveMs: 1000,           // debounce interval (default 1000ms)
  },
});

// All VFS changes auto-save after the debounce interval.
// Next create() with the same namespace auto-loads previous state.
sandbox.writeFile('/tmp/work.txt', encode('progress'));

// Clean up when done
await sandbox.clearPersistedState();
```

```typescript
// Session mode: manual save/load
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  persistence: {
    mode: 'session',
    namespace: 'my-session',
  },
});

await sandbox.saveState();  // explicit save
await sandbox.loadState();  // explicit load
```

Storage backends are auto-detected: `IndexedDB` in the browser, filesystem in Node.js. You can provide a custom `PersistenceBackend` for other storage systems.

## Snapshots and forking

### Snapshots

Save and restore in-memory checkpoints (VFS + env vars):

```typescript
const snapId = sandbox.snapshot();

await sandbox.run('rm -rf /home/user/*');

sandbox.restore(snapId);
// Filesystem is restored to the snapshot point
```

### Forking

Create a copy-on-write clone of the sandbox:

```typescript
const child = await sandbox.fork();

// Child has independent filesystem (COW), fresh process manager, copied env vars
await child.run('echo "child"');
await sandbox.run('echo "parent"');  // unaffected

child.destroy();
```

Forked sandboxes inherit all host mounts from the parent (shared by reference — efficient and safe for read-only mounts).

## Command history

```typescript
// Execute some commands
await sandbox.run('echo hello');
await sandbox.run('echo world');

// Retrieve history
const history = sandbox.getHistory();
// [{ index: 0, command: 'echo hello' }, { index: 1, command: 'echo world' }]

// Clear history
sandbox.clearHistory();
```

Also available as shell builtins: `history list` and `history clear`.

## PYTHONPATH

Mount Python libraries and configure the import path:

```typescript
const sandbox = await Sandbox.create({
  wasmDir: './wasm',
  mounts: [
    {
      path: '/mnt/libs',
      files: {
        'mymodule/__init__.py': encode(''),
        'mymodule/core.py': encode('GREETING = "hello from mymodule"'),
      },
    },
  ],
  pythonPath: ['/mnt/libs'],
});

await sandbox.run('python3 -c "from mymodule.core import GREETING; print(GREETING)"');
// stdout: "hello from mymodule\n"
```

`PYTHONPATH` is set to `[...yourPaths, '/usr/lib/python'].join(':')`. The `/usr/lib/python` entry is always appended (contains the socket shim when networking is enabled). Your paths take priority.

## Lifecycle

```typescript
// Create
const sandbox = await Sandbox.create({ wasmDir: './wasm' });

// Use
await sandbox.run('echo hello');

// Destroy (releases resources, stops autosave, disposes Worker)
sandbox.destroy();

// After destroy, all methods throw "Sandbox has been destroyed"
```

## API reference

### Sandbox

| Method | Returns | Description |
|--------|---------|-------------|
| `Sandbox.create(options)` | `Promise<Sandbox>` | Create a new sandbox |
| `run(command)` | `Promise<RunResult>` | Execute a shell command |
| `cancel()` | `void` | Cancel the running command |
| `readFile(path)` | `Uint8Array` | Read a file from the VFS |
| `writeFile(path, data)` | `void` | Write a file to the VFS |
| `readDir(path)` | `DirEntry[]` | List directory contents |
| `mkdir(path)` | `void` | Create a directory |
| `stat(path)` | `StatResult` | Get file/directory metadata |
| `rm(path)` | `void` | Delete a file |
| `mount(path, files)` | `void` | Mount files or a `VirtualProvider` |
| `setEnv(name, value)` | `void` | Set environment variable |
| `getEnv(name)` | `string \| undefined` | Get environment variable |
| `getHistory()` | `HistoryEntry[]` | Get command history |
| `clearHistory()` | `void` | Clear command history |
| `snapshot()` | `string` | Create a VFS + env snapshot |
| `restore(id)` | `void` | Restore a snapshot |
| `exportState()` | `Uint8Array` | Serialize sandbox state |
| `importState(blob)` | `void` | Restore serialized state |
| `saveState()` | `Promise<void>` | Save to persistence backend |
| `loadState()` | `Promise<boolean>` | Load from persistence backend |
| `clearPersistedState()` | `Promise<void>` | Delete persisted state |
| `fork()` | `Promise<Sandbox>` | Create a COW clone |
| `destroy()` | `void` | Release all resources |

### Types

| Type | Description |
|------|-------------|
| `SandboxOptions` | Configuration for `Sandbox.create()` |
| `MountConfig` | `{ path, files, writable? }` — creation-time mount |
| `RunResult` | Command execution result |
| `NetworkPolicy` | `{ allowedHosts?, blockedHosts?, onRequest? }` |
| `SecurityOptions` | `{ toolAllowlist?, limits?, hardKill?, onAuditEvent?, packagePolicy? }` |
| `SecurityLimits` | `{ timeoutMs?, stdoutBytes?, stderrBytes?, commandBytes?, fileCount?, memoryBytes? }` |
| `PersistenceOptions` | `{ mode, namespace?, autosaveMs?, backend? }` |
| `VirtualProvider` | Interface: `readFile`, `writeFile`, `exists`, `stat`, `readdir` |
| `HostMount` | Built-in `VirtualProvider` with in-memory file tree |
| `AuditEvent` | `{ type, sessionId, timestamp, ... }` |
