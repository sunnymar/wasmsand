# Sandbox Python Package System Design

## Problem

The MCP sandbox has a working Python interpreter but no ecosystem packages. LLMs (and users) expect `import numpy`, `import pandas`, etc. to work. We need Rust-backed implementations of key packages that are pip-discoverable and opt-in at sandbox creation time.

## Decisions

1. **Feature-gated binary**: Single `python3.wasm` built with Cargo features selecting which native modules to compile in. `cargo build --features numpy,pandas,sqlite3` or `--all-features` for everything. Python wrapper files gate runtime discoverability — packages only become importable when their wrapper files are installed.

2. **Instant pip install**: `pip install numpy` writes Python wrapper files from a built-in registry to the VFS. No network call, no download. The native module is already in the binary.

3. **Pre-installed via API**: `Sandbox.create({ packages: ['numpy', 'pandas'] })` makes packages immediately importable. No pip install needed in user code.

## Architecture

Three layers:

**Build time** — A Cargo workspace compiles RustPython + selected native module crates into one `python3.wasm`. Each native module is a Cargo feature — build with `--features numpy,pandas` or `--all-features`. Only selected modules are compiled in.

**Registry** — A `PackageRegistry` in the orchestrator holds metadata for each package: name, version, dependencies, and Python file contents. Static data structure, no network.

**Runtime** — When packages are requested (via `Sandbox.create()` or `pip install`), the orchestrator writes Python files to `/usr/lib/python/{name}/` in the VFS.

## Package Spectrum

Packages range from pure Python to native-heavy:

- **Native-heavy** (numpy, PIL): Most logic in Rust, Python layer is thin delegation to `_name_native` module
- **Hybrid** (pandas, matplotlib, sklearn): Substantial Python logic (DataFrame methods, plot config, model API) delegating to native for computation/IO
- **Pure Python** (requests): No native module, just Python files on VFS

## Target Packages

| Package | Native Module | Rust Backend | Key APIs |
|---------|--------------|-------------|----------|
| numpy | `_numpy_native` | ndarray | array, zeros, ones, arange, linspace, dot, reshape, linalg.* |
| pandas | `_pandas_native` | calamine + rust_xlsxwriter | DataFrame, Series, read_csv, read_excel, to_csv, to_excel |
| PIL | `_pil_native` | image + imageproc | Image.open, resize, crop, rotate, save, convert |
| matplotlib | `_matplotlib_native` | plotters + resvg | pyplot.plot, scatter, bar, hist, savefig (SVG/PNG) |
| sklearn | `_sklearn_native` | linfa | KMeans, PCA, LinearRegression, LogisticRegression, DecisionTree, train_test_split |
| sqlite3 | `_sqlite3_native` | sqlite (shared with sqlite3 CLI coreutil) | connect, execute, fetchall, fetchone, cursor, commit |
| requests | *(none)* | *(pure Python)* | get, post, put, delete — wrapper over urllib.request |

### Dependency Map

```
numpy:       no deps
pandas:      depends on numpy
PIL:         no deps
matplotlib:  depends on numpy
sklearn:     depends on numpy
sqlite3:     no deps
requests:    no deps
```

## Package Structure

Each Rust-backed package follows this pattern:

```
packages/python-packages/
  numpy/
    Cargo.toml              # depends on ndarray, rustpython-vm
    src/lib.rs              # #[pymodule] _numpy_native { ... }
    python/
      numpy/__init__.py     # real Python code, imports from _numpy_native
      numpy/linalg.py       # wraps native linalg functions
      numpy/random.py       # wraps native random functions
```

The Rust code exposes a `_name_native` module via RustPython's `#[pymodule]`. The Python files import from the native module and present the familiar API — default arguments, type coercion, convenience functions. For hybrid packages, the Python layer contains substantial logic beyond simple delegation.

Pure Python packages (requests) have no Rust crate — just the `python/` directory.

## Build System

Fat binary workspace:

```
packages/python-wasm/
  Cargo.toml              # workspace root
  src/main.rs             # RustPython entry, registers all native modules
  crates/
    numpy/                # _numpy_native
    pandas/               # _pandas_native
    pil/                  # _pil_native
    matplotlib/           # _matplotlib_native
    sklearn/              # _sklearn_native
    sqlite3/              # _sqlite3_native (shares sqlite lib with sqlite3 CLI coreutil)
```

`main.rs`:
```rust
InterpreterBuilder::new()
    .init_stdlib()
    .add_native_module("_numpy_native", numpy::module_def)
    .add_native_module("_pandas_native", pandas::module_def)
    .add_native_module("_pil_native", pil::module_def)
    .add_native_module("_matplotlib_native", matplotlib::module_def)
    .add_native_module("_sklearn_native", sklearn::module_def)
    .add_native_module("_sqlite3_native", sqlite3::module_def)
    .build()
```

Build examples:
```bash
# Full build with all packages
cargo build --target wasm32-wasip1 --release --all-features

# Minimal data science build
cargo build --target wasm32-wasip1 --release --features numpy,pandas,matplotlib,sqlite3

# Bare Python (no native packages)
cargo build --target wasm32-wasip1 --release
```

Note: The `sqlite3` feature gates both the Python `sqlite3` module and the `sqlite3` CLI coreutil — they share the same underlying sqlite library.

## Sandbox.create() API

```typescript
await Sandbox.create({
  packages: ['numpy', 'pandas', 'PIL'],  // NEW: opt-in packages
  // existing options unchanged:
  extensions: [...],
  network: { allow: ['*'] },
  timeout: 30000,
})
```

`packages` is an optional string array. Each entry is matched against the `PackageRegistry`. On match, the package's Python files are written to `/usr/lib/python/{name}/` in the VFS. Dependencies are auto-installed.

## PackageRegistry

```typescript
// packages/orchestrator/src/packages/registry.ts
interface PackageMetadata {
  name: string;
  version: string;
  dependencies: string[];
  pythonFiles: Record<string, string>;  // relative path → file content
}

const PACKAGE_REGISTRY: Map<string, PackageMetadata> = new Map([
  ['numpy', {
    name: 'numpy',
    version: '1.26.0',
    dependencies: [],
    pythonFiles: {
      'numpy/__init__.py': '...',
      'numpy/linalg.py': '...',
    }
  }],
  // ...
]);
```

Python file contents are embedded as string literals in TypeScript. Self-contained, no external file reads at runtime.

## pip Builtin Enhancements

Existing `builtinPip()` in shell-runner.ts extended:

- **`pip install numpy`** — looks up registry, writes Python files to VFS. Instant. Idempotent.
- **`pip uninstall numpy`** — removes Python files from VFS.
- **`pip list`** — shows installed packages and available (registry but not installed).
- **`pip install unknown-pkg`** — "Package not found. Available: numpy, pandas, ..."
