# Packaging & Distribution Design

## Goal

Create distributable packages for both the Python SDK (PyPI wheel) and the TypeScript library (npm), bundling all dependencies so users get a zero-config experience. Migrate development tooling from Node.js/tsx to Bun.

## Packages

### 1. `wasmsand` (PyPI) — Platform-specific wheels

Each wheel is fully self-contained:

```
wasmsand-0.0.1-py3-none-<platform>.whl
├── wasmsand/
│   ├── __init__.py
│   ├── sandbox.py
│   ├── commands.py
│   ├── files.py
│   ├── _rpc.py
│   ├── _types.py
│   └── _bundled/
│       ├── bun                      # platform-specific Bun binary (~50MB)
│       ├── server.js                # single-file bundle of sdk-server
│       └── wasm/
│           ├── wasmsand-shell.wasm
│           ├── python3.wasm
│           ├── cat.wasm
│           └── ... (44 coreutils)
├── wasmsand-0.0.1.dist-info/
```

**Target platforms:** `manylinux_2_17_x86_64`, `manylinux_2_17_aarch64`, `macosx_11_0_arm64`, `macosx_10_15_x86_64`, `win_amd64`

**Resource discovery in `sandbox.py`:**
- Installed mode: `_bundled/` relative to `__file__`
- Dev mode (fallback): repo-relative paths when `_bundled/` doesn't exist
- Subprocess: `_bundled/bun _bundled/server.js` (installed) or `bun server.ts` (dev)

### 2. `@wasmsand/sandbox` (npm) — Single package

```
@wasmsand/sandbox
├── package.json
├── dist/
│   ├── index.js              # main ESM entry (orchestrator)
│   ├── index.d.ts
│   ├── node-adapter.js
│   ├── node-adapter.d.ts
│   ├── browser-adapter.js
│   └── browser-adapter.d.ts
├── wasm/
│   ├── wasmsand-shell.wasm
│   ├── python3.wasm
│   ├── cat.wasm
│   └── ... (44 coreutils)
```

**Exports map:**
```json
{
  "exports": {
    ".": "./dist/index.js",
    "./node": "./dist/node-adapter.js",
    "./browser": "./dist/browser-adapter.js",
    "./wasm/*": "./wasm/*"
  }
}
```

**What happens to existing packages:**
- `@wasmsand/orchestrator` → becomes `@wasmsand/sandbox` (the published name)
- `@wasmsand/sdk-server` → stays internal, bundled into the Python wheel
- `packages/web` → stays private dev/demo app

## Bun Migration

| Before (Node/tsx) | After (Bun) |
|---|---|
| `npx tsx src/cli.ts` | `bun src/cli.ts` |
| `npx vitest` | `bun test` |
| `npx tsup` | `bun build` for single-file bundles; tsup for library builds |
| `node --import tsx server.ts` | `bun server.ts` |
| `import { describe } from 'vitest'` | `import { describe } from 'bun:test'` |
| `tsx` devDependency | removed |

**Test migration:** All test files switch from `vitest` imports to `bun:test`. Bun's test runner provides the same `describe/it/expect` API.

## Build Process

**Python wheel:**
```
make wheel PLATFORM=macosx_11_0_arm64
  1. bun build packages/sdk-server/src/server.ts --bundle --outfile=dist/server.js
  2. Download Bun binary for target platform
  3. Copy wasm/*.wasm from build output
  4. Copy Python source
  5. Build wheel with platform tag
```

**npm package:**
```
make npm
  1. tsup packages/orchestrator/src → dist/
  2. Copy wasm/*.wasm → wasm/
  3. npm pack
```

## Development Workflow

- `bun test` — runs all TS tests
- `bun run build:rust` — builds WASM binaries via cargo
- `cd packages/python-sdk && pytest` — Python tests (dev-mode paths)
- `make wheel` — builds wheel for current platform
- `make npm` — builds npm tarball

## Out of Scope (YAGNI)

- CI/CD for multi-platform wheel builds
- Auto-publishing to PyPI/npm
- CDN hosting for WASM binaries
- Changes to `packages/web` Vite app
