# Package Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `pip install <package>` to download and install packages from a codepod-controlled GitHub Pages registry, supporting both WASM+Python packages and pure-Python wheels.

**Architecture:** The shell-exec binary fetches `index.json` from the registry URL, resolves dependencies, downloads `.wasm` binaries and `.whl` files, extracts Python files from wheels via ZIP parsing, and registers WASM tools with the host process manager. A separate `codepod-packages` GitHub repo serves the registry via GitHub Pages.

**Tech Stack:** Rust (shell-exec), `zip` crate for wheel extraction, GitHub Pages for hosting, Python scripts for CI/build tooling.

**Spec:** `docs/superpowers/specs/2026-03-26-package-registry-design.md`

**Worktree:** `packages/shell-exec/` (main changes) + new `codepod-packages` repo
**Build:** `cargo build -p codepod-shell-exec --target wasm32-wasip1 --release`
**Test:** Integration tests via deno eval + shell runner

---

## Critical Patterns

### Host fetch API
```rust
let result = host.fetch(url, "GET", &[], None);
// result.ok: bool, result.status: u16, result.body: String, result.error: Option<String>
```

### Host register_tool API
```rust
host.register_tool("numpy", "/usr/share/pkg/bin/numpy.wasm")?;
```

### Host write_file API
```rust
host.write_file(path, content, WriteMode::Truncate)?;
```

### Existing pip data flow
- `pip-installed.json` at `/etc/codepod/pip-installed.json` — tracks installed packages
- `pip-registry.json` at `/etc/codepod/pip-registry.json` — local registry (pre-existing, for extensions)
- `BUILTIN_PACKAGES` const — packages compiled into the binary

---

## File Map

| File | Action |
|------|--------|
| `packages/shell-exec/Cargo.toml` | Modify — add `zip` dependency |
| `packages/shell-exec/src/wheel.rs` | Create — ZIP/wheel extraction |
| `packages/shell-exec/src/lib.rs` | Modify — add `mod wheel;` |
| `packages/shell-exec/src/virtual_commands.rs` | Modify — registry-based pip install |
| New repo: `codepod-packages/index.json` | Create — package index |
| New repo: `codepod-packages/tabulate/` | Create — test pure-Python package |
| New repo: `codepod-packages/scripts/build-index.py` | Create — index generator |
| New repo: `codepod-packages/scripts/add-pypi-package.py` | Create — PyPI wheel importer |

---

## Task 0: Set Up codepod-packages Repository

**Files:**
- Create: `codepod-packages/` (new GitHub repo)

- [ ] **Step 1: Create the repo locally**

```bash
mkdir -p ~/work/codepod/codepod-packages
cd ~/work/codepod/codepod-packages
git init
```

- [ ] **Step 2: Create initial index.json**

```json
{
  "version": 1,
  "registry_url": "https://codepod-sandbox.github.io/packages",
  "packages": {}
}
```

- [ ] **Step 3: Create add-pypi-package.py script**

```python
#!/usr/bin/env python3
"""Download a pure-Python wheel from PyPI and add it to the registry."""
import sys, json, os, urllib.request, zipfile, tempfile

def main():
    if len(sys.argv) < 2:
        print("Usage: add-pypi-package.py <package-name> [version]")
        sys.exit(1)

    name = sys.argv[1]
    version = sys.argv[2] if len(sys.argv) > 2 else None

    # Fetch package info from PyPI JSON API
    url = f"https://pypi.org/pypi/{name}/json"
    if version:
        url = f"https://pypi.org/pypi/{name}/{version}/json"

    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read())

    info = data["info"]
    ver = info["version"]

    # Find pure-Python wheel
    wheel_url = None
    wheel_filename = None
    for f in data["urls"]:
        fn = f["filename"]
        if fn.endswith(".whl") and ("py3-none-any" in fn or "py2.py3-none-any" in fn):
            wheel_url = f["url"]
            wheel_filename = fn
            break

    if not wheel_url:
        print(f"ERROR: No pure-Python wheel found for {name}=={ver}")
        sys.exit(1)

    # Download wheel
    pkg_dir = os.path.join("packages", name)
    os.makedirs(pkg_dir, exist_ok=True)
    dest = os.path.join(pkg_dir, wheel_filename)
    print(f"Downloading {wheel_filename}...")
    urllib.request.urlretrieve(wheel_url, dest)

    # Validate: no compiled extensions
    with zipfile.ZipFile(dest) as zf:
        for entry in zf.namelist():
            if entry.endswith((".so", ".pyd", ".dylib")):
                os.remove(dest)
                print(f"ERROR: Wheel contains compiled extension: {entry}")
                sys.exit(1)

    # Extract dependencies from METADATA
    deps = []
    with zipfile.ZipFile(dest) as zf:
        for entry in zf.namelist():
            if entry.endswith("/METADATA"):
                meta = zf.read(entry).decode("utf-8")
                for line in meta.split("\n"):
                    if line.startswith("Requires-Dist:"):
                        dep = line.split(":")[1].strip().split(";")[0].split()[0]
                        deps.append(dep)
                break

    size = os.path.getsize(dest)
    summary = info.get("summary", "")

    print(f"Added {name}=={ver} ({size} bytes, deps={deps})")
    print(f"  {dest}")
    print(f"Now run: python scripts/build-index.py")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Create build-index.py script**

```python
#!/usr/bin/env python3
"""Regenerate index.json from packages/ directory."""
import os, json, zipfile, glob

def main():
    packages = {}

    for pkg_dir in sorted(glob.glob("packages/*")):
        name = os.path.basename(pkg_dir)

        # Find wheel
        whls = glob.glob(os.path.join(pkg_dir, "*.whl"))
        if not whls:
            continue
        whl = whls[0]
        whl_rel = os.path.relpath(whl)

        # Find wasm (optional)
        wasms = glob.glob(os.path.join(pkg_dir, "*.wasm"))
        wasm_rel = os.path.relpath(wasms[0]) if wasms else None

        # Extract metadata from wheel
        version = ""
        summary = ""
        deps = []
        with zipfile.ZipFile(whl) as zf:
            for entry in zf.namelist():
                if entry.endswith("/METADATA"):
                    meta = zf.read(entry).decode("utf-8")
                    for line in meta.split("\n"):
                        if line.startswith("Version:"):
                            version = line.split(":", 1)[1].strip()
                        elif line.startswith("Summary:"):
                            summary = line.split(":", 1)[1].strip()
                        elif line.startswith("Requires-Dist:"):
                            dep = line.split(":")[1].strip().split(";")[0].split()[0]
                            deps.append(dep)
                    break

        size = sum(os.path.getsize(f) for f in [whl] + (wasms or []))

        packages[name] = {
            "version": version,
            "summary": summary,
            "wasm": wasm_rel if wasm_rel else None,
            "wheel": whl_rel,
            "depends": deps,
            "size_bytes": size,
        }

    index = {"version": 1, "packages": packages}

    with open("index.json", "w") as f:
        json.dump(index, f, indent=2)

    print(f"index.json updated: {len(packages)} packages")
    for name, info in sorted(packages.items()):
        wasm_tag = " +wasm" if info["wasm"] else ""
        print(f"  {name}=={info['version']}{wasm_tag} ({info['size_bytes']} bytes)")

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Add tabulate as test package**

```bash
python scripts/add-pypi-package.py tabulate 0.9.0
python scripts/build-index.py
```

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "Initial registry with tabulate package and build scripts"
```

Note: GitHub Pages needs to be enabled on the repo (Settings → Pages → Deploy from branch: main).

---

## Task 1: Add `zip` Crate Dependency

**Files:**
- Modify: `packages/shell-exec/Cargo.toml`

- [ ] **Step 1: Add zip to dependencies**

In `packages/shell-exec/Cargo.toml`, add under `[dependencies]`:
```toml
zip = { version = "2", default-features = false, features = ["deflate"] }
```

- [ ] **Step 2: Verify it compiles**

```bash
cargo build -p codepod-shell-exec --target wasm32-wasip1 --release 2>&1 | tail -3
```

Expected: `Finished` with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shell-exec/Cargo.toml Cargo.lock
git commit -m "deps: add zip crate for wheel extraction"
```

---

## Task 2: Create wheel.rs — ZIP/Wheel Extraction

**Files:**
- Create: `packages/shell-exec/src/wheel.rs`
- Modify: `packages/shell-exec/src/lib.rs` (add `pub mod wheel;`)

- [ ] **Step 1: Create wheel.rs**

```rust
//! Wheel (.whl) extraction — unzips Python wheels into the VFS.
//!
//! A Python wheel is a ZIP file. We extract all .py files, skipping
//! .dist-info/ and .data/ directories which contain metadata only.

use std::io::{Cursor, Read};

/// A single extracted file from a wheel.
pub struct WheelFile {
    /// Relative path (e.g. "tabulate/__init__.py")
    pub path: String,
    /// File contents as UTF-8 string
    pub content: String,
}

/// Extract Python files from a wheel (ZIP) archive.
///
/// The `data` parameter is the raw bytes of the .whl file.
/// Returns a list of (path, content) pairs for files to install.
///
/// Skips:
/// - `*.dist-info/` directories (metadata)
/// - `*.data/` directories (scripts, headers)
/// - Non-.py files (compiled extensions would fail anyway)
/// - `__pycache__/` directories
pub fn extract_wheel(data: &[u8]) -> Result<Vec<WheelFile>, String> {
    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("invalid wheel/zip: {e}"))?;

    let mut files = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;

        let name = entry.name().to_string();

        // Skip directories
        if name.ends_with('/') {
            continue;
        }

        // Skip dist-info and data directories
        if name.contains(".dist-info/") || name.contains(".data/") {
            continue;
        }

        // Skip __pycache__
        if name.contains("__pycache__/") {
            continue;
        }

        // Read content
        let mut content = String::new();
        entry.read_to_string(&mut content)
            .map_err(|e| format!("reading {name}: {e}"))?;

        files.push(WheelFile {
            path: name,
            content,
        });
    }

    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_empty_zip() {
        // Minimal valid ZIP (end-of-central-directory only)
        let data = [
            0x50, 0x4b, 0x05, 0x06, // EOCD signature
            0x00, 0x00, // disk number
            0x00, 0x00, // disk with CD
            0x00, 0x00, // entries on disk
            0x00, 0x00, // total entries
            0x00, 0x00, 0x00, 0x00, // CD size
            0x00, 0x00, 0x00, 0x00, // CD offset
            0x00, 0x00, // comment length
        ];
        let result = extract_wheel(&data).unwrap();
        assert!(result.is_empty());
    }
}
```

- [ ] **Step 2: Add module to lib.rs**

In `packages/shell-exec/src/lib.rs`, add:
```rust
pub mod wheel;
```

- [ ] **Step 3: Verify it compiles**

```bash
cargo build -p codepod-shell-exec --target wasm32-wasip1 --release 2>&1 | tail -3
```

- [ ] **Step 4: Run unit test**

```bash
cargo test -p codepod-shell-exec wheel -- --nocapture
```

- [ ] **Step 5: Commit**

```bash
git add packages/shell-exec/src/wheel.rs packages/shell-exec/src/lib.rs
git commit -m "feat: add wheel.rs — ZIP/wheel extraction for pip install"
```

---

## Task 3: Add Registry Data Structures

**Files:**
- Modify: `packages/shell-exec/src/virtual_commands.rs`

- [ ] **Step 1: Add registry index types**

After the existing `PipInstalledEntry` struct (~line 650), add:

```rust
/// Package entry from the remote codepod registry (index.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryIndex {
    version: u32,
    packages: std::collections::HashMap<String, RegistryPackage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryPackage {
    version: String,
    summary: String,
    wasm: Option<String>,
    wheel: String,
    #[serde(default)]
    depends: Vec<String>,
    #[serde(default)]
    size_bytes: usize,
}
```

- [ ] **Step 2: Add registry URL constant and fetch function**

After the `BUILTIN_PACKAGES` const:

```rust
/// Default registry URL. Can be overridden by CODEPOD_REGISTRY env var.
const DEFAULT_REGISTRY_URL: &str = "https://codepod-sandbox.github.io/packages";

/// Fetch the registry index, using a cached copy if available.
fn fetch_registry_index(state: &ShellState, host: &dyn HostInterface) -> Result<RegistryIndex, String> {
    // Check cache first
    let cache_path = "/etc/codepod/registry-index.json";
    if let Ok(cached) = host.read_file(cache_path) {
        if let Ok(index) = serde_json::from_str::<RegistryIndex>(&cached) {
            return Ok(index);
        }
    }

    // Fetch from registry
    let base_url = state.env.get("CODEPOD_REGISTRY")
        .cloned()
        .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());
    let url = format!("{base_url}/index.json");

    let result = host.fetch(&url, "GET", &[], None);
    if let Some(ref err) = result.error {
        return Err(format!("failed to fetch registry: {err}"));
    }
    if !result.ok {
        return Err(format!("registry returned status {}", result.status));
    }

    let index: RegistryIndex = serde_json::from_str(&result.body)
        .map_err(|e| format!("invalid registry index: {e}"))?;

    // Cache for this session
    let _ = host.mkdir("/etc/codepod");
    let _ = host.write_file(cache_path, &result.body, WriteMode::Truncate);

    Ok(index)
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cargo build -p codepod-shell-exec --target wasm32-wasip1 --release 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add packages/shell-exec/src/virtual_commands.rs
git commit -m "feat: add registry index types and fetch function"
```

---

## Task 4: Rewrite pip install for Registry Support

**Files:**
- Modify: `packages/shell-exec/src/virtual_commands.rs`

This replaces the existing `pip_install` function with registry-backed installation.

- [ ] **Step 1: Write the new pip_install function**

Replace the existing `pip_install` function body (keep the signature):

```rust
fn pip_install(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    // Filter out flags
    let mut no_cache = false;
    let names: Vec<&str> = args
        .iter()
        .map(|s| s.as_str())
        .filter(|a| {
            if *a == "--no-cache" { no_cache = true; return false; }
            !a.starts_with('-')
        })
        .collect();

    if names.is_empty() {
        shell_eprint!("{}", "pip install: no package specified\n");
        return RunResult::exit(1);
    }

    let installed = read_pip_installed(host);

    // Check builtins and already-installed first
    let mut to_resolve: Vec<&str> = Vec::new();
    for name in &names {
        let name_lower = name.to_lowercase();
        if BUILTIN_PACKAGES.iter().any(|(n, _)| n.to_lowercase() == name_lower) {
            shell_print!("Requirement already satisfied: {name}\n");
            continue;
        }
        if installed.iter().any(|i| i.name.to_lowercase() == name_lower) {
            shell_print!("Requirement already satisfied: {name}\n");
            continue;
        }
        to_resolve.push(name);
    }

    if to_resolve.is_empty() {
        return RunResult::empty();
    }

    // Clear cache if requested
    if no_cache {
        let _ = host.remove("/etc/codepod/registry-index.json", false);
    }

    // Try the existing local registry first (for extension-provided packages)
    let local_registry = read_pip_registry(host);

    // Fetch remote registry index
    let remote_index = match fetch_registry_index(state, host) {
        Ok(idx) => idx,
        Err(e) => {
            // Fall back to local registry only
            shell_eprint!("Warning: could not fetch registry: {e}\n");
            RegistryIndex { version: 1, packages: std::collections::HashMap::new() }
        }
    };

    // Resolve dependencies (topological order)
    let mut install_order: Vec<String> = Vec::new();
    let mut visited = std::collections::HashSet::new();

    for name in &to_resolve {
        resolve_registry_deps(&remote_index, name, &installed, &mut visited, &mut install_order);
    }

    if install_order.is_empty() {
        shell_print!("{}", "Requirement already satisfied\n");
        return RunResult::empty();
    }

    let base_url = state.env.get("CODEPOD_REGISTRY")
        .cloned()
        .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());

    let mut new_installed = read_pip_installed(host);
    let mut out = String::new();

    for pkg_name in &install_order {
        // Check local registry first
        if let Some(local_pkg) = local_registry.iter().find(|p| p.name == *pkg_name) {
            // Install from local registry (existing code path)
            let _ = host.mkdir("/usr/lib/python");
            for (path, content) in &local_pkg.files {
                let full_path = format!("/usr/lib/python/{path}");
                if let Some(parent) = full_path.rsplit_once('/') {
                    let _ = host.mkdir(parent.0);
                }
                let _ = host.write_file(&full_path, content, WriteMode::Truncate);
            }
            new_installed.push(PipInstalledEntry {
                name: local_pkg.name.clone(),
                version: local_pkg.version.clone(),
            });
            continue;
        }

        // Install from remote registry
        if let Some(pkg) = remote_index.packages.get(pkg_name) {
            shell_print!("Downloading {pkg_name}-{}...\n", pkg.version);

            // Download and install WASM binary if present
            if let Some(ref wasm_path) = pkg.wasm {
                let wasm_url = format!("{base_url}/{wasm_path}");
                let result = host.fetch(&wasm_url, "GET", &[], None);
                if let Some(ref err) = result.error {
                    shell_eprint!("pip install: failed to download {pkg_name}.wasm: {err}\n");
                    return RunResult::exit(1);
                }
                let _ = host.mkdir("/usr/share/pkg/bin");
                let dest = format!("/usr/share/pkg/bin/{pkg_name}.wasm");
                if let Err(e) = host.write_file(&dest, &result.body, WriteMode::Truncate) {
                    shell_eprint!("pip install: failed to write WASM: {e}\n");
                    return RunResult::exit(1);
                }
                if let Err(e) = host.register_tool(pkg_name, &dest) {
                    shell_eprint!("pip install: failed to register tool: {e}\n");
                    return RunResult::exit(1);
                }
            }

            // Download and extract wheel
            let wheel_url = format!("{base_url}/{}", pkg.wheel);
            let result = host.fetch(&wheel_url, "GET", &[], None);
            if let Some(ref err) = result.error {
                shell_eprint!("pip install: failed to download wheel: {err}\n");
                return RunResult::exit(1);
            }

            let wheel_bytes = result.body.as_bytes();
            match crate::wheel::extract_wheel(wheel_bytes) {
                Ok(files) => {
                    let _ = host.mkdir("/usr/lib/python");
                    for file in &files {
                        let full_path = format!("/usr/lib/python/{}", file.path);
                        if let Some((parent, _)) = full_path.rsplit_once('/') {
                            let _ = host.mkdir(parent);
                        }
                        let _ = host.write_file(&full_path, &file.content, WriteMode::Truncate);
                    }
                }
                Err(e) => {
                    shell_eprint!("pip install: failed to extract wheel: {e}\n");
                    return RunResult::exit(1);
                }
            }

            new_installed.push(PipInstalledEntry {
                name: pkg_name.clone(),
                version: pkg.version.clone(),
            });
        } else {
            shell_eprint!(
                "ERROR: Could not find a version that satisfies the requirement {pkg_name}\n"
            );
            return RunResult::exit(1);
        }
    }

    write_pip_installed(host, &new_installed);

    let names_str: Vec<String> = install_order.iter()
        .filter_map(|n| remote_index.packages.get(n).map(|p| format!("{n}-{}", p.version)))
        .collect();
    if !names_str.is_empty() {
        out.push_str(&format!("Successfully installed {}\n", names_str.join(" ")));
    }
    shell_print!("{}", out);
    RunResult::empty()
}

/// Recursively resolve dependencies from the registry index.
fn resolve_registry_deps(
    index: &RegistryIndex,
    name: &str,
    installed: &[PipInstalledEntry],
    visited: &mut std::collections::HashSet<String>,
    result: &mut Vec<String>,
) {
    let name_lower = name.to_lowercase();
    if visited.contains(&name_lower) {
        return;
    }
    if installed.iter().any(|i| i.name.to_lowercase() == name_lower) {
        return;
    }
    if BUILTIN_PACKAGES.iter().any(|(n, _)| n.to_lowercase() == name_lower) {
        return;
    }

    visited.insert(name_lower.clone());

    if let Some(pkg) = index.packages.get(name) {
        for dep in &pkg.depends {
            resolve_registry_deps(index, dep, installed, visited, result);
        }
    }

    result.push(name.to_string());
}
```

- [ ] **Step 2: Update pip_show to check registry**

In the `pip_show` function, before the "package not found" error at the end, add:

```rust
    // Check remote registry
    if let Ok(index) = fetch_registry_index(state, host) {
        let name_lower = name.to_lowercase();
        if let Some(pkg) = index.packages.iter().find(|(k, _)| k.to_lowercase() == name_lower) {
            let installed_str = if installed.iter().any(|i| i.name.to_lowercase() == name_lower) {
                "installed"
            } else {
                "available (not installed)"
            };
            shell_print!(
                "Name: {}\nVersion: {}\nSummary: {}\nStatus: {}\n",
                pkg.0, pkg.1.version, pkg.1.summary, installed_str
            );
            return RunResult::empty();
        }
    }
```

Note: `pip_show` needs `state` added to its signature: `fn pip_show(state: &ShellState, host: &dyn HostInterface, args: &[String])`.

- [ ] **Step 3: Update pip_list to show registry-available packages**

No change needed — `pip_list` already shows installed packages correctly.

- [ ] **Step 4: Verify it compiles**

```bash
cargo build -p codepod-shell-exec --target wasm32-wasip1 --release 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add packages/shell-exec/src/virtual_commands.rs
git commit -m "feat: registry-backed pip install with wheel extraction"
```

---

## Task 5: Build WASM and Integration Test

**Files:**
- WASM binary copy to test fixtures

- [ ] **Step 1: Build and copy WASM**

```bash
cargo build -p codepod-shell-exec --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/codepod-shell-exec.wasm packages/orchestrator/src/shell/__tests__/fixtures/codepod-shell-exec.wasm
cp target/wasm32-wasip1/release/codepod-shell-exec.wasm packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm
```

- [ ] **Step 2: Test pip install with a real registry**

This requires the `codepod-packages` repo to be published on GitHub Pages. For local testing, use a mock:

```bash
deno eval --no-check "
import { ShellInstance } from './packages/orchestrator/src/shell/shell-instance.js';
import { ProcessManager } from './packages/orchestrator/src/process/manager.js';
import { VFS } from './packages/orchestrator/src/vfs/vfs.js';
import { NodeAdapter } from './packages/orchestrator/src/platform/node-adapter.js';
// ... setup shell instance ...
// Write a mock registry index to /etc/codepod/registry-index.json
// Test: pip install tabulate
// Test: pip list shows tabulate
// Test: pip show tabulate
"
```

- [ ] **Step 3: Test pip install for already-installed packages**

```
pip install numpy → "Requirement already satisfied: numpy"
pip install tabulate → downloads and installs
pip install tabulate → "Requirement already satisfied: tabulate"
pip install nonexistent → "ERROR: Could not find..."
```

- [ ] **Step 4: Run regression tests**

```bash
deno test -A --no-check packages/orchestrator/src/shell/__tests__/conformance/shell.test.ts
```

Expected: All existing tests pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/shell/__tests__/fixtures/codepod-shell-exec.wasm
git add packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm
git commit -m "feat: complete pip install with registry support"
```

---

## Task 6: Publish codepod-packages to GitHub

- [ ] **Step 1: Create GitHub repo**

```bash
cd ~/work/codepod/codepod-packages
gh repo create codepod-sandbox/packages --public --source=. --push
```

- [ ] **Step 2: Enable GitHub Pages**

Go to Settings → Pages → Deploy from branch: `main`, directory: `/ (root)`.

- [ ] **Step 3: Verify index.json is accessible**

```bash
curl -s https://codepod-sandbox.github.io/packages/index.json | head -20
```

- [ ] **Step 4: Test end-to-end in sandbox**

```bash
# In the codepod repo, test pip install tabulate via the live registry
deno eval --no-check "..." # full integration test
```

---

## Gotchas

| Issue | Fix |
|-------|-----|
| `host.fetch()` returns body as String, not bytes | Wheel data may have binary content. If body is UTF-8 lossy, ZIP parsing may fail. May need to add `fetch_bytes` to host interface, or base64-encode wheel data in the registry. |
| WASM binary in fetch body | Same issue — WASM files are binary. `host.fetch().body` is a String. Either base64-encode in registry or add binary fetch support. |
| `pip_show` doesn't have `state` param | Need to update signature and call site in `cmd_pip`. |
| Dependency cycles | The `resolve_registry_deps` function uses a visited set to prevent infinite loops. |
| Registry URL not reachable | Falls back gracefully with a warning; local registry still works. |
