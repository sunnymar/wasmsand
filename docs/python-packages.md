# Python Packages in Codepod

## Two Modes: Fat Binary vs Lean Binary

Codepod supports two `python3.wasm` builds:

**Fat binary** — all native packages compiled in. Fast, large (~28MB).
```bash
cargo build -p codepod-python --features numpy,pil,matplotlib --target wasm32-wasip1
```

**Lean binary** — only RustPython + stdlib. Small (~5MB). Packages installed on demand via `pip install`.
```bash
cargo build -p codepod-python --target wasm32-wasip1
```

Choose fat when you know what packages you need upfront (production sandboxes). Choose lean when binary size matters or packages are installed dynamically (interactive/exploratory use).

## How pip install Works

### Pure Python packages (tabulate, sympy, seaborn)

Downloaded as `.whl` files from the codepod package registry, extracted to `/usr/lib/python/`. Works identically on fat and lean binaries.

```
pip install tabulate
→ fetch index.json from registry
→ download tabulate-0.9.0-py3-none-any.whl
→ extract .py files to /usr/lib/python/tabulate/
```

### Native packages (numpy, pillow, pandas)

These have Rust code that must run as WASM. The behavior depends on the binary:

**On fat binary:** `pip install numpy` → "Requirement already satisfied." The native code is compiled in. Nothing to download.

**On lean binary:** `pip install numpy` downloads three things:
1. `numpy-native.wasm` — the Rust native code as a standalone WASM module
2. `numpy-*.whl` — the Python wrappers (same as fat binary)
3. `_numpy_native.py` — a bridge shim

The bridge shim routes calls through `_codepod.native_call()`, which the host dispatches to the standalone numpy WASM:

```
Python: numpy.array([1,2,3])
  → _numpy_native.array_new([1,2,3])        # bridge shim
    → _codepod.native_call("numpy", "array_new", "[1,2,3]")
      → host loads numpy-native.wasm
        → invoke("array_new", "[1,2,3]")     # Rust code runs
      ← returns JSON result
    ← returns to Python
```

### Transparent compatibility

The same Python wrapper code (`import numpy`) works on both binaries. On the fat binary, `import _numpy_native` finds the compiled-in Rust module. On the lean binary, it finds the `.py` bridge shim. RustPython native modules always take priority over PYTHONPATH files, so the bridge shim is only used when the native module isn't compiled in.

## Performance Tradeoffs

| Operation | Fat binary | Lean + bridge |
|-----------|-----------|---------------|
| `import numpy` | ~50ms | ~200ms |
| `np.array([1,2,3])` | ~0.1ms | ~5ms |
| `np.dot(A, B)` 100×100 | ~2ms | ~10ms |
| `np.sum(large_array)` 10K | ~1ms | ~50ms |

The bridge adds overhead from:
- JSON serialization/deserialization of arguments and results
- Two WASM boundary crossings (python3 → host → numpy)
- Memory copies between the two WASM linear memories

For interactive use and demos, this is acceptable. For compute-heavy workloads (training loops, large matrix operations), use the fat binary.

## Package Registry

All packages (pure Python and native) are served from a codepod-controlled GitHub Pages registry at `https://codepod-sandbox.github.io/packages/`.

No PyPI fallback — only packages in the registry are installable. This ensures:
- Every package is tested with RustPython
- No C extensions that can't run in WASM
- Security: controlled supply chain

### Registry structure

```
index.json                          # Package index
packages/
  tabulate/
    tabulate-0.9.0-py3-none-any.whl
  numpy/
    numpy-native-1.26.4.wasm        # Native module WASM
    numpy-1.26.4-py3-none-any.whl   # Python wrappers
    shims/_numpy_native.py           # Bridge shim
```

### Adding packages

Pure Python packages from PyPI:
```bash
python3 scripts/add-pypi-package.py <package-name> [version]
python3 scripts/build-index.py
```

Or use the GitHub Actions workflow: Actions → Add PyPI Package → Run workflow.

## pip Policy

The sandbox administrator controls pip install via policy:

```typescript
Sandbox.create({
  security: {
    pipPolicy: {
      enabled: true,                          // allow pip install
      allowedPackages: ['tabulate', 'numpy'], // whitelist (optional)
      blockedPackages: ['badpkg'],            // blacklist (optional)
      maxPackages: 10,                        // limit (optional)
    },
  },
});
```

MCP server CLI:
```bash
codepod-mcp --pip-allow tabulate --pip-allow numpy  # whitelist
codepod-mcp --pip-block badpkg                       # blacklist
codepod-mcp --no-pip                                 # disable entirely
```

## Built-in Packages

These are always available (compiled into the fat binary or installed as shims):

| Package | Version | Type |
|---------|---------|------|
| numpy | 1.26.4 | Native (fat) or bridge (lean) |
| matplotlib | 3.8.0 | Native (fat) or bridge (lean) |
| Pillow | 10.4.0 | Native (fat) or bridge (lean) |
| requests | 2.32.0 | Python shim (always lightweight) |

`pip list` reports these as installed. `pip install numpy` on a fat binary says "Requirement already satisfied."

## Adding a New Native Module (for contributors)

To add a new native package (e.g., `scipy`) to the bridge:

1. **Create the Rust crate** at `packages/python/crates/scipy-native-wasm/`
   - Export `invoke(method, args) -> result` (JSON RPC)
   - Export `__alloc(size) -> ptr` for memory management
   - Compile to `wasm32-wasip1`

2. **Create the bridge shim** `_scipy_native.py`
   - Routes calls through `_codepod.native_call("scipy", method, args)`

3. **Add to the registry** in `codepod-packages`
   - Upload `.wasm` + `.whl` + shim
   - Update `index.json` with `native_wasm` and `native_shim` fields

4. **Optionally add to the fat binary**
   - Add feature flag in `packages/python/Cargo.toml`
   - Add `add_native_module` in `packages/python/src/main.rs`
