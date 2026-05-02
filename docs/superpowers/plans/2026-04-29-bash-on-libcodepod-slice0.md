# Bash on libcodepod Slice 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mechanically rename the current Rust bash package from `shell-exec` / `codepod-shell-exec` to `bash-rs` / `codepod-bash` without changing runtime behavior.

**Architecture:** This slice is naming-only. The existing resident-mode `__run_command` ABI, `host.rs`, `WasmHost`, and fixture install behavior stay intact so later slices can refactor behavior against a stable package name.

**Tech Stack:** Rust workspace, Deno/TypeScript consumers, shell build scripts, wasm32-wasip1 fixtures.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/bash-rs/` | Renamed Rust shell package, formerly `packages/shell-exec/`. |
| `packages/bash-rs/Cargo.toml` | Package/bin/lib names change to `codepod-bash` / `codepod_bash`. |
| `packages/bash-rs/src/main.rs` | Resident wasm entrypoint; imports renamed library crate. |
| `Cargo.toml` | Workspace member points at `packages/bash-rs`. |
| `scripts/build-coreutils.sh` | Builds `codepod-bash` and copies the Cargo artifact into `bash.wasm` fixtures. |
| `scripts/copy-wasm.sh`, `examples/*/copy-wasm.sh` | Copy the renamed wasm artifact. |
| TypeScript/Python/Rust server defaults | Default shell wasm paths move from `codepod-shell-exec.wasm` to `bash.wasm`. |
| Tests | Fixture constants move to `bash.wasm`. |

## Task 1: Mechanical Package Rename

**Files:**
- Move: `packages/shell-exec/` -> `packages/bash-rs/`
- Modify: `Cargo.toml`
- Modify: `packages/bash-rs/Cargo.toml`
- Modify: `packages/bash-rs/src/main.rs`

- [ ] **Step 1: Move the package directory**

Run:

```bash
git mv packages/shell-exec packages/bash-rs
```

Expected: `git status --short packages/shell-exec packages/bash-rs` shows a rename.

- [ ] **Step 2: Rename Cargo package, binary, and library**

In `packages/bash-rs/Cargo.toml`, replace:

```toml
name = "codepod-shell-exec"
```

with:

```toml
name = "codepod-bash"
```

Replace the binary name:

```toml
name = "codepod-shell-exec"
```

with:

```toml
name = "codepod-bash"
```

Replace the library name:

```toml
name = "codepod_shell_exec"
```

with:

```toml
name = "codepod_bash"
```

- [ ] **Step 3: Update workspace member**

In root `Cargo.toml`, replace:

```toml
"packages/shell-exec",
```

with:

```toml
"packages/bash-rs",
```

- [ ] **Step 4: Update Rust crate imports**

In `packages/bash-rs/src/main.rs`, replace `codepod_shell_exec::` with `codepod_bash::`.

- [ ] **Step 5: Verify Rust package selection**

Run:

```bash
cargo metadata --no-deps --format-version 1
```

Expected: output contains package `codepod-bash` and no package `codepod-shell-exec`.

## Task 2: Rename Build Artifact References

**Files:**
- Modify: `scripts/build-coreutils.sh`
- Modify: `scripts/copy-wasm.sh`
- Modify: `scripts/build-mcp.sh`
- Modify: `scripts/smoke-test-mcp.sh`
- Modify: `examples/web-cli/src/main.ts`
- Modify: `examples/web-cli/copy-wasm.sh`
- Modify: `examples/llm/copy-wasm.sh`
- Modify: `packages/*` consumers that default to `codepod-shell-exec.wasm`

- [ ] **Step 1: Replace package selector**

Replace cargo package selector:

```bash
-p codepod-shell-exec
```

with:

```bash
-p codepod-bash
```

- [ ] **Step 2: Replace wasm artifact filename**

Replace runtime artifact references:

```text
codepod-shell-exec.wasm
```

with:

```text
bash.wasm
```

Remove bash-specific asyncify artifact names. Asyncification is handled
by the kernel/tooling layer, so this slice should not introduce
`bash-asyncify.wasm` or `codepod-bash-asyncify.wasm`.

- [ ] **Step 3: Replace user-facing package wording in touched runtime files**

In comments/log messages touched by this slice, replace `shell-exec` with `bash-rs` or `codepod-bash` depending on whether the text refers to the package directory or artifact.

- [ ] **Step 4: Verify no active runtime references remain**

Run:

```bash
rg -n "packages/shell-exec|codepod-shell-exec|codepod_shell_exec|shell-exec\\.wasm|shell-exec-asyncify|codepod-bash\\.wasm|bash-asyncify|codepod-bash-asyncify" Cargo.toml packages scripts examples
```

Expected: no old `shell-exec` matches. `codepod-bash.wasm` may appear
only in build scripts that copy Cargo's package artifact into the
runtime fixture name `bash.wasm`.

## Task 3: Verify Slice 0

**Files:**
- All files changed by Tasks 1 and 2.

- [ ] **Step 1: Format Rust metadata-sensitive files**

Run:

```bash
cargo fmt -p codepod-bash
```

Expected: command exits 0.

- [ ] **Step 2: Run package tests**

Run:

```bash
cargo test -p codepod-bash
```

Expected: tests pass with behavior unchanged.

- [ ] **Step 3: Build wasm artifact**

Run:

```bash
cargo build --target wasm32-wasip1 --release -p codepod-bash
```

Expected: `target/wasm32-wasip1/release/codepod-bash.wasm` exists.
When fixtures are copied, that package artifact is copied as
`bash.wasm`.

- [ ] **Step 4: Run diff checks**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Review diff**

Run:

```bash
git diff --stat
```

Expected: changes are mechanical rename plus artifact path updates only.
