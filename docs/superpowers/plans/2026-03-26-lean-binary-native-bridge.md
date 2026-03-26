# Lean Binary + Native Module Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `pip install numpy` on a lean `python3.wasm` to dynamically load numpy's native Rust code via a host-mediated WASM bridge, so `import numpy` works identically on fat and lean binaries.

**Architecture:** The lean python3.wasm includes only RustPython + `_codepod`. When pip installs a native package, it downloads a standalone `numpy-native.wasm` (which exports `invoke(method, args) -> result`) plus a `_numpy_native.py` shim that routes calls through `_codepod.native_call()`. The host loads the native WASM and dispatches calls to it.

**Tech Stack:** Rust (codepod-host, numpy-native-wasm), TypeScript (kernel-imports, NativeModuleRegistry), WASM

**Spec:** `docs/superpowers/specs/2026-03-26-lean-binary-native-bridge-design.md`

---

## Critical Patterns

### Existing host import pattern (Rust → host → response)
```rust
// In codepod-host/src/lib.rs
extern "C" { fn host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32; }
let response = call_host_json(host_network_fetch, &request_json)?;
```

### Existing kernel import pattern (TypeScript host handler)
```typescript
// In kernel-imports.ts
async host_network_fetch(reqPtr, reqLen, outPtr, outCap): Promise<number> {
  const reqJson = readString(memory, reqPtr, reqLen);
  // ... do work ...
  return writeJson(memory, outPtr, outCap, result);
}
```

### KernelImportsOptions extension point
```typescript
export interface KernelImportsOptions {
  memory: WebAssembly.Memory;
  kernel?: ProcessKernel;
  networkBridge?: NetworkBridgeLike;
  // NEW: nativeModules?: NativeModuleRegistry;
}
```

---

## File Map

| File | Action |
|------|--------|
| `packages/orchestrator/src/process/native-modules.ts` | **Create** — NativeModuleRegistry: load WASM, dispatch invoke() |
| `packages/orchestrator/src/host-imports/kernel-imports.ts` | **Modify** — add `host_native_invoke` handler |
| `packages/orchestrator/src/process/manager.ts` | **Modify** — wire NativeModuleRegistry, expose to kernel imports |
| `packages/python/crates/codepod-host/src/lib.rs` | **Modify** — add `native_call()` pyfunction + `host_native_invoke` extern |
| `packages/python/crates/numpy-native-wasm/Cargo.toml` | **Create** — standalone numpy WASM crate |
| `packages/python/crates/numpy-native-wasm/src/lib.rs` | **Create** — invoke() dispatcher wrapping numpy-rust-core |
| `packages/shell-exec/src/virtual_commands.rs` | **Modify** — pip install handles `native_wasm` + `native_shim` |
| `codepod-packages` repo | **Update** — add numpy to registry |

---

## Task 0: Create NativeModuleRegistry (TypeScript)

**Files:**
- Create: `packages/orchestrator/src/process/native-modules.ts`

- [ ] **Step 1: Create NativeModuleRegistry class**

```typescript
/**
 * Registry for dynamically loaded native Python module WASMs.
 *
 * Each module exports: invoke(method_ptr, method_len, args_ptr, args_len, out_ptr, out_cap) -> i32
 * The host loads the WASM, dispatches calls, and copies results back.
 */
import type { PlatformAdapter } from '../platform/adapter.js';

export class NativeModuleRegistry {
  private instances: Map<string, WebAssembly.Instance> = new Map();
  private adapter: PlatformAdapter;

  constructor(adapter: PlatformAdapter) {
    this.adapter = adapter;
  }

  /** Load a native module WASM from a file path (VFS or host). */
  async loadModule(name: string, wasmBytes: Uint8Array): Promise<void> {
    const module = await WebAssembly.compile(wasmBytes);

    // Provide minimal WASI imports so the WASM can allocate memory
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 256 }); // 1MB-16MB
    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: {
        proc_exit: () => {},
        fd_write: () => 0,
        fd_close: () => 0,
        fd_seek: () => 0,
        fd_read: () => 0,
        environ_get: () => 0,
        environ_sizes_get: () => 0,
        args_get: () => 0,
        args_sizes_get: () => 0,
        clock_time_get: () => 0,
        random_get: (buf: number, len: number) => {
          const view = new Uint8Array(memory.buffer, buf, len);
          crypto.getRandomValues(view);
          return 0;
        },
      },
      env: { memory },
    };

    const instance = await WebAssembly.instantiate(module, imports);
    this.instances.set(name, instance);
  }

  /** Check if a module is loaded. */
  has(name: string): boolean {
    return this.instances.has(name);
  }

  /** Invoke a method on a loaded native module. Returns JSON string. */
  invoke(name: string, method: string, argsJson: string): string {
    const instance = this.instances.get(name);
    if (!instance) {
      return JSON.stringify({ error: `native module '${name}' not loaded` });
    }

    const exports = instance.exports;
    const invoke = exports.invoke as (
      method_ptr: number, method_len: number,
      args_ptr: number, args_len: number,
      out_ptr: number, out_cap: number,
    ) => number;
    const alloc = exports.__alloc as (size: number) => number;
    const dealloc = exports.__dealloc as (ptr: number, size: number) => void;
    const memory = exports.memory as WebAssembly.Memory;

    if (!invoke || !alloc || !memory) {
      return JSON.stringify({ error: `native module '${name}' missing invoke/alloc exports` });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Write method string into WASM memory
    const methodBytes = encoder.encode(method);
    const methodPtr = alloc(methodBytes.length);
    new Uint8Array(memory.buffer, methodPtr, methodBytes.length).set(methodBytes);

    // Write args JSON into WASM memory
    const argsBytes = encoder.encode(argsJson);
    const argsPtr = alloc(argsBytes.length);
    new Uint8Array(memory.buffer, argsPtr, argsBytes.length).set(argsBytes);

    // Allocate output buffer
    let outCap = 65536; // 64KB initial
    let outPtr = alloc(outCap);

    let n = invoke(methodPtr, methodBytes.length, argsPtr, argsBytes.length, outPtr, outCap);

    // Retry with larger buffer if needed
    if (n > outCap) {
      if (dealloc) dealloc(outPtr, outCap);
      outCap = n;
      outPtr = alloc(outCap);
      n = invoke(methodPtr, methodBytes.length, argsPtr, argsBytes.length, outPtr, outCap);
    }

    const result = decoder.decode(new Uint8Array(memory.buffer, outPtr, n));

    // Clean up
    if (dealloc) {
      dealloc(methodPtr, methodBytes.length);
      dealloc(argsPtr, argsBytes.length);
      dealloc(outPtr, outCap);
    }

    return result;
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
deno check packages/orchestrator/src/process/native-modules.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/process/native-modules.ts
git commit -m "feat: add NativeModuleRegistry for dynamic native Python modules"
```

---

## Task 1: Add host_native_invoke to Kernel Imports

**Files:**
- Modify: `packages/orchestrator/src/host-imports/kernel-imports.ts`

- [ ] **Step 1: Add nativeModules to KernelImportsOptions**

After the `extensionHandler` field (~line 50):
```typescript
  /** Registry of dynamically loaded native Python module WASMs. */
  nativeModules?: NativeModuleRegistry;
```

Add import at top:
```typescript
import type { NativeModuleRegistry } from '../process/native-modules.js';
```

- [ ] **Step 2: Add host_native_invoke handler**

After `host_network_fetch` handler (~line 225), add:

```typescript
    // host_native_invoke(module_ptr, module_len, method_ptr, method_len,
    //                    args_ptr, args_len, out_ptr, out_cap) -> i32
    // Calls invoke() on a dynamically loaded native Python module WASM.
    host_native_invoke(
      modulePtr: number, moduleLen: number,
      methodPtr: number, methodLen: number,
      argsPtr: number, argsLen: number,
      outPtr: number, outCap: number,
    ): number {
      if (!opts.nativeModules) {
        return writeJson(memory, outPtr, outCap, { error: 'native modules not available' });
      }
      const moduleName = readString(memory, modulePtr, moduleLen);
      const method = readString(memory, methodPtr, methodLen);
      const argsJson = readString(memory, argsPtr, argsLen);

      const result = opts.nativeModules.invoke(moduleName, method, argsJson);
      const encoded = new TextEncoder().encode(result);
      if (encoded.length > outCap) {
        return encoded.length; // signal need more space
      }
      new Uint8Array(memory.buffer, outPtr, encoded.length).set(encoded);
      return encoded.length;
    },
```

- [ ] **Step 3: Verify compilation**

```bash
deno check packages/orchestrator/src/host-imports/kernel-imports.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/host-imports/kernel-imports.ts
git commit -m "feat: add host_native_invoke kernel import for native module bridge"
```

---

## Task 2: Wire NativeModuleRegistry into ProcessManager

**Files:**
- Modify: `packages/orchestrator/src/process/manager.ts`
- Modify: `packages/orchestrator/src/sandbox.ts`

- [ ] **Step 1: Add NativeModuleRegistry to ProcessManager**

In manager.ts, add field and expose it:
```typescript
import { NativeModuleRegistry } from './native-modules.js';

// In ProcessManager class:
readonly nativeModules: NativeModuleRegistry;

// In constructor:
this.nativeModules = new NativeModuleRegistry(adapter);
```

- [ ] **Step 2: Pass nativeModules to createKernelImports**

In `spawnSync` and `spawnAsyncProcess` where `createKernelImports` is called, add:
```typescript
imports.codepod = createKernelImports({
  memory: memoryProxy,
  networkBridge: this.networkBridge ?? undefined,
  extensionHandler: this.extensionHandler ?? undefined,
  nativeModules: this.nativeModules,  // NEW
});
```

- [ ] **Step 3: Verify no regressions**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/sandbox.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/process/manager.ts packages/orchestrator/src/sandbox.ts
git commit -m "feat: wire NativeModuleRegistry into ProcessManager and kernel imports"
```

---

## Task 3: Add _codepod.native_call() to Python Host Bridge

**Files:**
- Modify: `packages/python/crates/codepod-host/src/lib.rs`

- [ ] **Step 1: Add host_native_invoke extern declaration**

In the `extern "C"` block (~line 23):
```rust
    fn host_native_invoke(
        module_ptr: *const u8, module_len: u32,
        method_ptr: *const u8, method_len: u32,
        args_ptr: *const u8, args_len: u32,
        out_ptr: *mut u8, out_cap: u32,
    ) -> i32;
```

- [ ] **Step 2: Add native_call Python function**

In the `_codepod` module (after `extension_call`):

```rust
    /// Call a method on a dynamically loaded native module.
    ///
    /// Usage: `_codepod.native_call(module, method, args_json) -> result_json_str`
    #[pyfunction]
    fn native_call(
        module: vm::builtins::PyStrRef,
        method: vm::builtins::PyStrRef,
        args_json: vm::builtins::PyStrRef,
        py_vm: &VirtualMachine,
    ) -> PyResult<vm::PyObjectRef> {
        #[cfg(target_arch = "wasm32")]
        {
            let request_json = format!(
                "{{\"module\":\"{}\",\"method\":\"{}\",\"args\":{}}}",
                json_escape(module.as_str()),
                json_escape(method.as_str()),
                args_json.as_str(),
            );

            // Use the dedicated host_native_invoke import for efficiency:
            // passes module/method/args separately to avoid double-JSON overhead
            let module_bytes = module.as_str().as_bytes();
            let method_bytes = method.as_str().as_bytes();
            let args_bytes = args_json.as_str().as_bytes();

            let mut out_buf = vec![0u8; 65536];
            let rc = unsafe {
                host_native_invoke(
                    module_bytes.as_ptr(), module_bytes.len() as u32,
                    method_bytes.as_ptr(), method_bytes.len() as u32,
                    args_bytes.as_ptr(), args_bytes.len() as u32,
                    out_buf.as_mut_ptr(), out_buf.len() as u32,
                )
            };

            if rc < 0 {
                return Err(py_vm.new_exception_msg(
                    py_vm.ctx.exceptions.runtime_error.to_owned(),
                    format!("native_call failed with error code {}", rc),
                ));
            }

            let len = rc as usize;
            if len > out_buf.len() {
                out_buf.resize(len, 0);
                let rc2 = unsafe {
                    host_native_invoke(
                        module_bytes.as_ptr(), module_bytes.len() as u32,
                        method_bytes.as_ptr(), method_bytes.len() as u32,
                        args_bytes.as_ptr(), args_bytes.len() as u32,
                        out_buf.as_mut_ptr(), out_buf.len() as u32,
                    )
                };
                if rc2 < 0 {
                    return Err(py_vm.new_exception_msg(
                        py_vm.ctx.exceptions.runtime_error.to_owned(),
                        format!("native_call retry failed with error code {}", rc2),
                    ));
                }
                out_buf.truncate(rc2 as usize);
            } else {
                out_buf.truncate(len);
            }

            let result_str = String::from_utf8(out_buf).map_err(|e| {
                py_vm.new_exception_msg(
                    py_vm.ctx.exceptions.runtime_error.to_owned(),
                    format!("invalid UTF-8 in native response: {}", e),
                )
            })?;

            // Return as Python string — the caller (shim) will json.loads() it
            Ok(py_vm.ctx.new_str(result_str).into())
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = (module, method, args_json);
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.native_call() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }
```

- [ ] **Step 3: Build python3.wasm (lean — no features)**

```bash
cargo build -p codepod-python --target wasm32-wasip1 --release
```

- [ ] **Step 4: Commit**

```bash
git add packages/python/crates/codepod-host/src/lib.rs
git commit -m "feat: add _codepod.native_call() for native module bridge"
```

---

## Task 4: Create numpy-native-wasm Crate (Minimal Proof-of-Concept)

**Files:**
- Create: `packages/python/crates/numpy-native-wasm/Cargo.toml`
- Create: `packages/python/crates/numpy-native-wasm/src/lib.rs`

Start with just ONE function (`array_new`) to prove the bridge works end-to-end.

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "numpy-native-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = "s"
lto = true
```

Note: this does NOT depend on numpy-rust-core yet — we start with a stub that proves the bridge works, then wire in the real core.

- [ ] **Step 2: Create src/lib.rs with invoke() export**

```rust
//! Standalone native module WASM for numpy.
//!
//! Exports: invoke(method_ptr, method_len, args_ptr, args_len, out_ptr, out_cap) -> i32
//! Also exports: __alloc(size) -> ptr, __dealloc(ptr, size)

use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn __alloc(size: usize) -> *mut u8 {
    if size == 0 { return std::ptr::null_mut(); }
    let layout = Layout::from_size_align(size, 1).unwrap();
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn __dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 { return; }
    let layout = Layout::from_size_align(size, 1).unwrap();
    unsafe { dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn invoke(
    method_ptr: *const u8, method_len: usize,
    args_ptr: *const u8, args_len: usize,
    out_ptr: *mut u8, out_cap: usize,
) -> usize {
    let method = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(method_ptr, method_len)) };
    let args = unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(args_ptr, args_len)) };

    let result = dispatch(method, args);

    let result_bytes = result.as_bytes();
    if result_bytes.len() > out_cap {
        return result_bytes.len(); // signal need more space
    }
    unsafe {
        std::ptr::copy_nonoverlapping(result_bytes.as_ptr(), out_ptr, result_bytes.len());
    }
    result_bytes.len()
}

fn dispatch(method: &str, args_json: &str) -> String {
    match method {
        "ping" => {
            // Simple test: return the args back
            format!("{{\"ok\":true,\"echo\":{}}}", args_json)
        }
        "array_new" => {
            // Proof of concept: create a string representation of an array
            format!("{{\"ok\":true,\"repr\":\"array({})\"}}", args_json)
        }
        "add" => {
            // Parse two numbers and add them
            let args: Vec<f64> = serde_json::from_str(args_json).unwrap_or_default();
            if args.len() >= 2 {
                let result = args[0] + args[1];
                format!("{{\"ok\":true,\"result\":{}}}", result)
            } else {
                r#"{"ok":false,"error":"add requires 2 arguments"}"#.to_string()
            }
        }
        _ => {
            format!("{{\"ok\":false,\"error\":\"unknown method: {}\"}}", method)
        }
    }
}
```

- [ ] **Step 3: Build for WASM**

```bash
cargo build -p numpy-native-wasm --target wasm32-wasip1 --release
ls -la target/wasm32-wasip1/release/numpy_native_wasm.wasm
```

- [ ] **Step 4: Commit**

```bash
git add packages/python/crates/numpy-native-wasm/
git commit -m "feat: numpy-native-wasm proof-of-concept with invoke() export"
```

---

## Task 5: Update pip install to Handle Native Modules

**Files:**
- Modify: `packages/shell-exec/src/virtual_commands.rs`

- [ ] **Step 1: Update RegistryPackage struct**

Add new fields:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryPackage {
    version: String,
    summary: String,
    wasm: Option<String>,        // standalone tool WASM (register_tool)
    wheel: String,
    #[serde(default)]
    depends: Vec<String>,
    #[serde(default)]
    size_bytes: usize,
    // NEW fields:
    native_wasm: Option<String>, // native module WASM (bridge)
    native_shim: Option<String>, // _foo_native.py bridge shim
}
```

- [ ] **Step 2: In pip_install, after wheel extraction, handle native_wasm + native_shim**

After the wheel extraction block, add:
```rust
            // Download and install native module WASM if present
            if let Some(ref native_path) = pkg.native_wasm {
                let native_url = format!("{base_url}/{native_path}");
                let result = host.fetch(&native_url, "GET", &[], None);
                if result.error.is_some() || !result.ok {
                    let err = result.error.unwrap_or_else(|| format!("status {}", result.status));
                    shell_eprint!("pip install: failed to download native WASM: {err}\n");
                    return RunResult::exit(1);
                }
                let native_bytes = result.body_bytes();
                let _ = host.mkdir("/usr/share/pkg/native");
                let dest = format!("/usr/share/pkg/native/{pkg_name}.wasm");
                let body_str = String::from_utf8_lossy(&native_bytes);
                if let Err(e) = host.write_file(&dest, &body_str, WriteMode::Truncate) {
                    shell_eprint!("pip install: failed to write native WASM: {e}\n");
                    return RunResult::exit(1);
                }
                // Signal the host to load this native module
                // (use register_tool with a special prefix that the host recognizes)
                let reg_name = format!("__native__{pkg_name}");
                let _ = host.register_tool(&reg_name, &dest);
                shell_print!("  Loaded native module {pkg_name}\n");
            }

            // Download and install native bridge shim if present
            if let Some(ref shim_path) = pkg.native_shim {
                let shim_url = format!("{base_url}/{shim_path}");
                let result = host.fetch(&shim_url, "GET", &[], None);
                if result.error.is_some() || !result.ok {
                    let err = result.error.unwrap_or_else(|| format!("status {}", result.status));
                    shell_eprint!("pip install: failed to download native shim: {err}\n");
                    return RunResult::exit(1);
                }
                let _ = host.mkdir("/usr/lib/python");
                let shim_filename = shim_path.rsplit('/').next().unwrap_or("_native.py");
                let dest = format!("/usr/lib/python/{shim_filename}");
                if let Err(e) = host.write_file(&dest, &result.body, WriteMode::Truncate) {
                    shell_eprint!("pip install: failed to write native shim: {e}\n");
                    return RunResult::exit(1);
                }
            }
```

- [ ] **Step 3: Build and verify**

```bash
cargo build -p codepod-shell-exec --target wasm32-wasip1 --release
```

- [ ] **Step 4: Commit**

```bash
git add packages/shell-exec/src/virtual_commands.rs
git commit -m "feat: pip install downloads native WASM + bridge shim for native modules"
```

---

## Task 6: End-to-End Integration Test

- [ ] **Step 1: Build lean python3.wasm**

```bash
cargo build -p codepod-python --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/python3.wasm packages/orchestrator/src/platform/__tests__/fixtures/python3-lean.wasm
```

- [ ] **Step 2: Upload numpy-native-wasm + shim to codepod-packages**

Create `_numpy_native.py` bridge shim:
```python
"""Bridge shim: routes _numpy_native calls through _codepod.native_call()."""
import _codepod
import json as _json

def _call(method, *args):
    result_str = _codepod.native_call("numpy", method, _json.dumps(args))
    result = _json.loads(result_str)
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "native call failed"))
    return result.get("result", result)

def ping(*args): return _call("ping", *args)
def array_new(*args): return _call("array_new", *args)
def add(*args): return _call("add", *args)
```

Upload to codepod-packages:
```bash
cd ~/work/codepod/codepod-packages
mkdir -p packages/numpy-poc/shims
cp .../numpy_native_wasm.wasm packages/numpy-poc/numpy-native-0.1.0.wasm
cp .../shims/_numpy_native.py packages/numpy-poc/shims/_numpy_native.py
python3 scripts/build-index.py  # update index with native_wasm + native_shim
git add -A && git commit -m "feat: add numpy-native POC" && git push
```

- [ ] **Step 3: Test end-to-end in sandbox**

```bash
# Create sandbox with lean binary + networking
deno eval --no-check "
import { Sandbox } from './packages/orchestrator/src/sandbox.js';
// ... create sandbox with python3-lean.wasm ...
// pip install numpy-poc
// python3 -c 'import _numpy_native; print(_numpy_native.ping(42))'
"
```

- [ ] **Step 4: Commit test**

```bash
git commit -m "test: end-to-end native module bridge proof of concept"
```

---

## Gotchas

| Issue | Fix |
|-------|-----|
| `host.write_file()` takes String, not bytes — WASM binary gets corrupted | Same `body_bytes()` issue as wheel download. For native WASM, may need base64-in-VFS approach or binary write support. |
| `host_native_invoke` called during retry doubles the call | Same as `host_network_fetch` — native modules are stateless so retry is safe. |
| Native module WASM needs its own memory | Each native module gets a fresh `WebAssembly.Memory` — no sharing with python3.wasm. |
| `__alloc`/`__dealloc` exports needed | Native WASM must export memory management so host can write args into its memory. |
| On fat binary, compiled-in `_numpy_native` takes priority | RustPython resolves native modules before PYTHONPATH. The `.py` shim is only found on lean binary. |
| `register_tool("__native__numpy", path)` convention | ProcessManager needs to recognize the `__native__` prefix and route to NativeModuleRegistry instead of tool registry. |
