# Lifo-Inspired Capabilities Spec for Wasmsand

## Goal

Add the highest-value capabilities observed in `lifo` to make `wasmsand` a stronger LLM compute runtime:

1. In-sandbox package manager (`pkg`)
2. First-class filesystem persistence modes
3. Virtual system providers (`/proc`, `/dev`)
4. Shell ergonomics for long autonomous runs (history, completion, jobs)
5. Optional JavaScript runtime compatibility layer

This spec is scoped for `wasmsand`'s stated product intent: a lightweight compute tool for LLMs, not a full browser-native OS.

## Context

Source project reviewed:
- `/Users/sunny/work/wasmsand/tmp/lifo/README.md`
- `/Users/sunny/work/wasmsand/tmp/lifo/packages/core/src/pkg/PackageManager.ts`
- `/Users/sunny/work/wasmsand/tmp/lifo/packages/core/src/kernel/persistence/PersistenceManager.ts`
- `/Users/sunny/work/wasmsand/tmp/lifo/packages/core/src/shell/jobs.ts`
- `/Users/sunny/work/wasmsand/tmp/lifo/packages/core/src/node-compat/index.ts`

Current `wasmsand` baseline (already strong):
- WASI/WASM tool execution + shell parser/interpreter
- Python runtime integration
- VFS + snapshot/restore/fork
- Security controls (tool allowlist, output/command/file-count limits, audit hooks)
- Worker-based hard kill path in Node environments

## Product Principles

1. Default safe: deny-by-default network/package installs unless explicitly enabled.
2. Deterministic enough for agents: stable output formats and error classes.
3. Lightweight core: optional features must not bloat baseline startup path.
4. Explicit policy surface: avoid hidden behavior.

## Non-Goals

- Full Linux emulation
- Arbitrary native binary execution
- Complete Node.js parity
- A full multi-user package ecosystem

## Feature Set and Priorities

### P0: `pkg` Package Manager (Sandbox-Native)

#### User Value

Allows LLMs to install utility scripts/modules into sandbox state instead of requiring host rebuilds.

#### Scope

Add a `pkg` command with:
- `pkg install <url> [--name <name>]`
- `pkg remove <name>`
- `pkg list`
- `pkg info <name>`

Initial package format:
- Remote JavaScript text file (`.js`) fetched via controlled network policy.
- Installed into sandbox VFS:
  - `/usr/share/pkg/node_modules/<name>/index.js`
  - metadata in `/usr/share/pkg/packages.json`

#### Security Policy

New security options:

```ts
interface PackagePolicy {
  enabled: boolean;                 // default false
  allowedHosts?: string[];          // package source allowlist
  maxPackageBytes?: number;         // per package payload cap
  maxInstalledPackages?: number;    // prevent unbounded growth
  allowOverwrite?: boolean;         // default false
}
```

Add to sandbox options:

```ts
interface SecurityOptions {
  packagePolicy?: PackagePolicy;
}
```

#### Error Model

- `E_PKG_DISABLED`
- `E_PKG_HOST_DENIED`
- `E_PKG_TOO_LARGE`
- `E_PKG_EXISTS`
- `E_PKG_NOT_FOUND`
- `E_PKG_INVALID`

#### Audit Events

- `package.install.start`
- `package.install.complete`
- `package.install.denied`
- `package.remove`

### P0: Persistence Modes

#### User Value

Supports long-running agent workflows that survive process/browser restarts.

#### Scope

Add persistence mode to sandbox creation:

```ts
interface PersistenceOptions {
  mode: 'ephemeral' | 'session' | 'persistent';
  namespace?: string;     // partition key for persisted state
  autosaveMs?: number;    // debounce interval (default 1000)
}
```

Semantics:
- `ephemeral`: current behavior, in-memory only.
- `session`: in-memory with explicit export/import APIs.
- `persistent`: backend persistence enabled (Node: file/db backend, Browser: IndexedDB backend).

Add methods:
- `save(): Promise<void>`
- `load(): Promise<void>`
- `exportState(): Uint8Array`
- `importState(blob: Uint8Array): void`

#### Data Model

Persist:
- VFS tree and metadata
- environment map
- installed package metadata

Do not persist:
- running commands/jobs
- transient pipes/fds

#### Safety

- persistence namespace isolation required
- optional max persisted size cap
- checksum/version metadata for compatibility

### P1: Virtual Providers (`/proc`, `/dev`)

#### User Value

Improves compatibility with scripts/tools expecting basic Unix introspection paths.

#### Scope

Provide read-only virtual files:

`/proc`
- `uptime`
- `meminfo`
- `cpuinfo`
- `version`

`/dev`
- `null`
- `zero`
- `random`
- `urandom`

Implementation model:
- Virtual inode provider layer in VFS path resolution.
- Generated-on-read files, not persisted as regular files.

#### Security

- No host-sensitive leaks.
- Use sandbox/runtime metadata only (or coarse synthesized values).

### P1: Shell Ergonomics for Agent Loops

#### User Value

Reduces retry churn and improves autonomous task completion in long sessions.

#### Scope

Add:
- command history API (`history list`, `history clear`)
- basic completion API (programmatic suggestions for command/path/env)
- job table visibility (`jobs`, `fg`, `bg`) for async/background commands

Notes:
- programmatic LLM workflows should expose these via RPC endpoints even if no interactive TTY.

#### RPC Surface

New methods:
- `shell.history.list`
- `shell.history.clear`
- `shell.complete`
- `jobs.list`
- `jobs.signal` (limited set)

### P2: Optional JS Runtime (`node` command + compat subset)

#### User Value

Enables JS script execution in environments where Python is not ideal and unlocks ecosystem tooling.

#### Scope

Add `node` command with minimal module compatibility:
- `fs`, `path`, `events`, `buffer`, `util`, `os`, `process`

Explicit exclusions in v1:
- real networking sockets from JS runtime
- full event loop parity
- child process spawning outside sandbox command pipeline

#### Policy

```ts
interface JsRuntimePolicy {
  enabled: boolean;            // default false
  allowedModules?: string[];   // optional stricter subset
}
```

## API Changes (Wasmsand)

### Sandbox Options

```ts
interface SandboxOptions {
  // existing
  wasmDir: string;
  timeoutMs?: number;
  fsLimitBytes?: number;
  security?: SecurityOptions;

  // new
  persistence?: PersistenceOptions;
}
```

### Security Options Additions

```ts
interface SecurityOptions {
  // existing fields...
  packagePolicy?: PackagePolicy;
  jsRuntimePolicy?: JsRuntimePolicy;
}
```

## RPC/SDK Changes

Add to sdk-server dispatcher:
- `pkg.install`, `pkg.remove`, `pkg.list`, `pkg.info`
- `persistence.save`, `persistence.load`, `persistence.export`, `persistence.import`
- `shell.history.list`, `shell.history.clear`, `shell.complete`
- `jobs.list`, `jobs.signal`

Python SDK additions:
- `sandbox.pkg.install(...)`, `sandbox.pkg.list()`, ...
- `sandbox.persistence.save()`, `sandbox.persistence.load()`

## Implementation Mapping (Current Repo)

Primary targets:
- `packages/orchestrator/src/sandbox.ts`
- `packages/orchestrator/src/vfs/vfs.ts`
- `packages/orchestrator/src/shell/shell-runner.ts`
- `packages/orchestrator/src/security.ts`
- `packages/orchestrator/src/network/*`
- `packages/sdk-server/src/dispatcher.ts`
- `packages/sdk-server/src/server.ts`
- `packages/python-sdk/src/wasmsand/*`

New modules (proposed):
- `packages/orchestrator/src/pkg/manager.ts`
- `packages/orchestrator/src/persistence/{types.ts,manager.ts,node-backend.ts,browser-backend.ts}`
- `packages/orchestrator/src/vfs/providers/{proc.ts,dev.ts}`
- `packages/orchestrator/src/runtime-js/*`

## Rollout Plan

### Phase 1 (P0): Packages + Persistence Core

Deliver:
- `pkg` command set
- package policy enforcement
- persistence mode API (`ephemeral` + `session` first)
- export/import state APIs

### Phase 2 (P0/P1): Persistent Backends + Virtual Providers

Deliver:
- Node persistence backend
- Browser IndexedDB persistence backend
- `/proc` and `/dev` provider layer

### Phase 3 (P1): Shell Ergonomics

Deliver:
- history/complete/job RPC APIs
- non-interactive job management for agents

### Phase 4 (P2): JS Runtime (Optional)

Deliver:
- `node` command and minimal compatibility subset
- module policy enforcement

## Acceptance Criteria

### AC-PKG

1. `pkg install` stores files and metadata in VFS.
2. installs are blocked when policy disabled.
3. installs from denied host return `E_PKG_HOST_DENIED`.
4. `pkg list/info/remove` round-trip behaves consistently across persistence save/load.

### AC-PERSIST

1. persistent mode restores prior files/env after sandbox restart.
2. session export/import reproduces identical state hash.
3. namespace isolation prevents cross-namespace reads.

### AC-PROCDEV

1. `/proc/*` files are readable and return expected schema.
2. `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` semantics match expectations.

### AC-SHELL

1. `shell.history.list` returns ordered entries.
2. `shell.complete` returns command/path suggestions.
3. background job appears in `jobs.list` and can be signaled.

### AC-JS

1. `node -e` executes basic JS and reads/writes VFS via compat layer.
2. disabled runtime policy blocks `node` execution.

## Test Plan

Add/extend tests:
- `packages/orchestrator/src/__tests__/pkg.test.ts`
- `packages/orchestrator/src/__tests__/persistence.test.ts`
- `packages/orchestrator/src/__tests__/providers.test.ts`
- `packages/orchestrator/src/shell/__tests__/jobs-history-complete.test.ts`
- `packages/sdk-server/src/dispatcher.test.ts` (new RPC methods)
- `packages/python-sdk/tests/test_pkg.py`
- `packages/python-sdk/tests/test_persistence.py`

Adversarial tests:
- package payload too large
- install loop until package count cap hit
- corrupted persistence blob import
- provider path traversal attempts

## Open Questions

1. Package artifact format: plain JS only vs signed manifest bundles?
2. Node runtime scope: should `http` module be included in v1?
3. Persistence encryption at rest: in-scope now or follow-up?
4. Should package installs be mirrored into tool discovery (`/bin`) automatically?

## Recommendation

For `wasmsand`'s LLM compute focus, implement in this order:
1. `pkg` + policy
2. persistence modes
3. `/proc` + `/dev`
4. history/completion/jobs APIs
5. optional JS runtime

This sequence maximizes agent utility with limited surface-area risk.

