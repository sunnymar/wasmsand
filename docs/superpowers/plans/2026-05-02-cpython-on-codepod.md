# CPython on Codepod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CPython 3.14.4 as a Codepod C port, run it as temporary `cpython3`, and use its failures to drive missing ABI work.

**Architecture:** CPython is an upstream-pinned C port under `packages/c-ports/cpython/`. Bring-up builds `cpython3.wasm` with `cpcc`/`cpar`/`cpranlib` and `libcodepod.a` while RustPython continues to own `python3`; after canaries pass, a later cutover PR replaces RustPython.

**Tech Stack:** CPython 3.14.4, wasi-sdk, CPython `Tools/wasm/wasi.py`, Codepod `cpcc` toolchain, `libcodepod.a`, Deno sandbox tests.

---

## File Map

- Create `packages/c-ports/cpython/README.md` — port status, version, build commands, known gaps.
- Create `packages/c-ports/cpython/.gitignore` — ignore build output only.
- Create `packages/c-ports/cpython/Makefile` — submodule init, worktree staging, CPython WASI build entrypoints, fixture copy.
- Create `packages/c-ports/cpython/patches/3.14/.gitkeep` — patch stack location.
- Create `packages/c-ports/cpython/canaries/` — Python canary snippets used by tests and manual verification.
- Modify `.gitmodules` — add `packages/c-ports/cpython/upstream` pointing at `https://github.com/python/cpython.git`.
- Modify `packages/c-ports/README.md` — list CPython as an in-progress upstream-pin port.
- Modify sandbox registration only after `cpython3.wasm` exists — add `cpython3`, not `python3`, during bring-up.
- Add Deno tests only after a runnable artifact exists — skipped or fixture-gated until `cpython3.wasm` is present.

## Task 1: Port Skeleton And Source Pin

**Files:**
- Create: `packages/c-ports/cpython/README.md`
- Create: `packages/c-ports/cpython/.gitignore`
- Create: `packages/c-ports/cpython/patches/3.14/.gitkeep`
- Modify: `.gitmodules`
- Modify: `packages/c-ports/README.md`

- [ ] **Step 1: Add the CPython submodule**

Run:

```bash
git submodule add https://github.com/python/cpython.git packages/c-ports/cpython/upstream
git -C packages/c-ports/cpython/upstream checkout v3.14.4
```

Expected: `.gitmodules` has a `packages/c-ports/cpython/upstream` entry and the submodule is pinned at tag `v3.14.4`.

- [ ] **Step 2: Create port metadata**

Create `packages/c-ports/cpython/README.md`:

```markdown
# CPython port

CPython 3.14.4 built for `wasm32-wasip1` through Codepod's C toolchain.

Bring-up artifact: `cpython3.wasm`.
Final cutover artifact: `python3.wasm`, replacing RustPython once the
CPython canaries cover the current product paths.

## Build

```bash
make -C packages/c-ports/cpython
```

## Status

Initial bring-up. RustPython still owns the `python3` command until the
CPython ABI canaries pass.
```

Create `packages/c-ports/cpython/.gitignore`:

```gitignore
/build/
```

Create the patch directory:

```bash
mkdir -p packages/c-ports/cpython/patches/3.14
touch packages/c-ports/cpython/patches/3.14/.gitkeep
```

- [ ] **Step 3: Update C ports index**

Add this row to `packages/c-ports/README.md`:

```markdown
| `cpython/` | [python/cpython](https://github.com/python/cpython) `v3.14.4` | submodule (upstream-pin, bring-up) | `cpython3.wasm` (temporary; replaces RustPython `python3.wasm` at cutover) |
```

- [ ] **Step 4: Verify skeleton**

Run:

```bash
git submodule status packages/c-ports/cpython/upstream
git diff --check -- .gitmodules packages/c-ports/README.md packages/c-ports/cpython
```

Expected: submodule status shows a checked-out CPython commit; `git diff --check` prints no errors.

- [ ] **Step 5: Commit**

```bash
git add .gitmodules packages/c-ports/README.md packages/c-ports/cpython
git commit -m "build(cpython): add cpython port skeleton"
```

## Task 2: Build Driver Discovery

**Files:**
- Create: `packages/c-ports/cpython/Makefile`
- Create: `packages/c-ports/cpython/canaries/print.py`

- [ ] **Step 1: Add a failing Makefile target**

Create a minimal `packages/c-ports/cpython/Makefile` target that fails if the submodule is missing and prints the expected build variables:

```make
REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
UPSTREAM := upstream
BUILD_DIR := build
WORK_DIR := $(BUILD_DIR)/work
INSTALL_DIR := $(BUILD_DIR)/install

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib

.PHONY: all submodule-init print-build-env clean

all: $(BUILD_DIR)/cpython3.wasm

submodule-init:
	@if [ ! -f $(UPSTREAM)/Tools/wasm/wasi.py ]; then \
		echo "==> Initializing CPython submodule"; \
		cd $(REPO_ROOT) && git submodule update --init packages/c-ports/cpython/$(UPSTREAM); \
	fi

print-build-env: submodule-init
	@echo "CPCC=$(CPCC)"
	@echo "CPAR=$(CPAR)"
	@echo "CPRANLIB=$(CPRANLIB)"
	@echo "INSTALL_DIR=$(INSTALL_DIR)"

$(BUILD_DIR)/cpython3.wasm:
	@echo "CPython build driver not implemented yet" >&2
	@exit 2

clean:
	rm -rf $(BUILD_DIR)
```

- [ ] **Step 2: Verify the intentional failure**

Run:

```bash
make -C packages/c-ports/cpython
```

Expected: exits `2` with `CPython build driver not implemented yet`.

- [ ] **Step 3: Add the first canary snippet**

Create `packages/c-ports/cpython/canaries/print.py`:

```python
print(1 + 2)
```

- [ ] **Step 4: Commit**

```bash
git add packages/c-ports/cpython/Makefile packages/c-ports/cpython/canaries/print.py
git commit -m "build(cpython): add build driver placeholder"
```

## Task 3: Baseline Upstream WASI Build

**Files:**
- Modify: `packages/c-ports/cpython/Makefile`
- Modify: `packages/c-ports/cpython/README.md`

- [ ] **Step 1: Run upstream CPython WASI build manually**

From a clean worktree copy, run:

```bash
cd packages/c-ports/cpython/upstream
python3 Tools/wasm/wasi.py build -- --config-cache
```

Expected: either produces an upstream WASI Python artifact, or fails with a concrete missing dependency/configuration issue. Record the exact outcome in `packages/c-ports/cpython/README.md`.

- [ ] **Step 2: Add the working upstream-build command to Makefile**

If `Tools/wasm/wasi.py` works, add an `upstream-wasi-build` target:

```make
.PHONY: upstream-wasi-build

upstream-wasi-build: submodule-init
	cd $(UPSTREAM) && python3 Tools/wasm/wasi.py build -- --config-cache
```

If it fails before configure due to missing host dependencies, keep the target and document the dependency. Do not patch CPython yet.

- [ ] **Step 3: Verify target reproduces the same result**

Run:

```bash
make -C packages/c-ports/cpython upstream-wasi-build
```

Expected: same result as the manual command.

- [ ] **Step 4: Commit**

```bash
git add packages/c-ports/cpython/Makefile packages/c-ports/cpython/README.md
git commit -m "build(cpython): document upstream wasi build"
```

## Task 4: Codepod Compiler Wrapper Build Attempt

**Files:**
- Modify: `packages/c-ports/cpython/Makefile`
- Create or modify: `packages/c-ports/cpython/patches/3.14/*.patch` only if needed to make configure reach the compiler/linker.

- [ ] **Step 1: Ensure Codepod toolchain builds**

Run:

```bash
source scripts/dev-init.sh
cargo build --release -p cpcc-toolchain
make -C packages/guest-compat lib
```

Expected: `target/release/cpcc`, `target/release/cpar`, `target/release/cpranlib`, and the compatibility archive exist.

- [ ] **Step 2: Add a Codepod build target**

Add a target that stages a worktree and attempts CPython's WASI build with Codepod compiler wrappers:

```make
.PHONY: worktree codepod-wasi-build

worktree: submodule-init
	mkdir -p $(WORK_DIR)
	rsync -a --delete --exclude='.git' $(UPSTREAM)/ $(WORK_DIR)/
	if [ -d patches/3.14 ] && ls patches/3.14/*.patch >/dev/null 2>&1; then \
		for p in patches/3.14/*.patch; do \
			echo "==> Applying $$p"; \
			git -C $(WORK_DIR) apply --whitespace=nowarn $(abspath $$p); \
		done; \
	fi

codepod-wasi-build: worktree
	cd $(WORK_DIR) && \
		CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
		python3 Tools/wasm/wasi.py build -- --config-cache
```

- [ ] **Step 3: Run and capture the first real failure**

Run:

```bash
make -C packages/c-ports/cpython codepod-wasi-build
```

Expected: either builds, or fails with a concrete CPython configure/build issue. Add the exact failure and classification to `README.md`.

- [ ] **Step 4: Commit**

```bash
git add packages/c-ports/cpython
git commit -m "build(cpython): attempt codepod wasi build"
```

## Task 5: First Runnable Artifact Or ABI Failure

**Files:**
- Modify: `packages/c-ports/cpython/Makefile`
- Modify: `packages/c-ports/cpython/README.md`
- Add tests only if `cpython3.wasm` exists.

- [ ] **Step 1: If build succeeds, copy fixture**

Add:

```make
.PHONY: copy-fixtures

copy-fixtures: $(BUILD_DIR)/cpython3.wasm
	cp $(BUILD_DIR)/cpython3.wasm $(FIXTURES)/cpython3.wasm
```

- [ ] **Step 2: If build fails, create the first patch or ABI task**

Classify the failure as:

- CPython build gate patch;
- missing `guest-compat` symbol;
- missing kernel host import/backend;
- missing local toolchain dependency.

Then add the smallest patch/test for that category. Do not skip directly to Python-level shims.

- [ ] **Step 3: Verify**

Run whichever command is now meaningful:

```bash
make -C packages/c-ports/cpython copy-fixtures
```

or the focused failing command from Step 2.

- [ ] **Step 4: Commit**

```bash
git add packages/c-ports/cpython packages/guest-compat packages/orchestrator
git commit -m "build(cpython): reach first codepod build milestone"
```

## Task 6: Sandbox `cpython3` Registration

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts`
- Create: `packages/orchestrator/src/__tests__/cpython.test.ts`

- [ ] **Step 1: Write skipped/fixture-gated test**

Create a Deno test that skips when `fixtures/cpython3.wasm` is absent. When present, it creates a sandbox and runs:

```ts
const result = await sandbox.run('cpython3 -c "print(1 + 2)"');
assertEquals(result.exitCode, 0);
assertEquals(result.stdout.trim(), "3");
```

- [ ] **Step 2: Verify red if fixture exists**

Run:

```bash
source scripts/dev-init.sh
deno test -A --no-check packages/orchestrator/src/__tests__/cpython.test.ts
```

Expected: skip without fixture, or fail because `cpython3` is not registered.

- [ ] **Step 3: Register `cpython3` side-by-side**

In `Sandbox.registerTools()` add `cpython3` only when `${wasmDir}/cpython3.wasm` exists. Do not change `python3`.

- [ ] **Step 4: Verify**

Run the same Deno test.

Expected: skip without fixture, or pass with fixture.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts packages/orchestrator/src/__tests__/cpython.test.ts
git commit -m "feat(cpython): register cpython3 during bring-up"
```

## Self-Review

- Spec coverage: covers version 3.14.4, temporary `cpython3`, RustPython replacement boundary, CPython WASI build structure, staged subprocess canary, and clean import environment.
- Placeholder scan: the plan intentionally records unknown build failures as discovery outputs; each task specifies exact files and commands.
- Type consistency: artifact names are `cpython3.wasm`/`cpython3` during bring-up and `python3` only at cutover.
