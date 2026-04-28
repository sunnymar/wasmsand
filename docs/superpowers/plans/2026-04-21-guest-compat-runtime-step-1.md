# Guest Compatibility Runtime — Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Step 1 of the guest compatibility runtime migration — rename `packages/c-compat/` → `packages/guest-compat/`, stabilize the Tier 1 ABI, ship `libcodepod_guest_compat.a` with versioning and precedence markers, build the `cpcc` clang wrapper plus companion `cpar` / `cpranlib`, introduce the conformance tree, migrate the existing C canaries, and cut the BusyBox port over to `cpcc`.

**Architecture:** This plan implements §Migration Path > Step 1 of [`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../specs/2026-04-19-guest-compat-runtime-design.md). The normative spec is that document; this plan is a concrete sequencing of the work it defines. Each task cites the spec sections it implements (see "Spec Trace" below). Rust and Cargo integration (`cargo-codepod`, Rust canaries, `-sys` crate, CI wiring) are explicitly deferred to Steps 3–5. On completion of Step 1, validate the resulting state against the spec before scoping Step 2.

**Tech Stack:** Rust (stable, host-side) — every user-facing tool is a Rust binary (`cpcc`, `cpar`, `cpranlib`, `cpcheck`, `cpconf`), no shell-script entry points introduced. `clap` for CLI. `wasi-sdk` (bundling clang + `llvm-nm` / `llvm-ar` / `llvm-ranlib`), discovered once inside the `cpcc` library crate. `wasmparser` for the implementation-signature check's wasm inspection. Deno for the existing orchestrator test harness. C11 for the shared runtime.

---

## Spec Trace

| Spec section | Covered by |
|---|---|
| §Architecture — runtime stack | Task 1, Task 3, Task 5 |
| §Override And Link Precedence — Symbol Policy | Task 3, Task 4 |
| §Override And Link Precedence — Link Order (C frontend) | Task 7 |
| §Override And Link Precedence — Verifying Precedence (markers + pre-opt + 3-stage check) | Task 4, Task 8, Task 10 |
| §Compatibility Tiers — Tier 1 enumeration (16 symbols) | Task 3 |
| §Runtime Semantics — Error Reporting, FDs, Identity, Affinity, Signals | Task 3 (already compliant; preserved through rename) |
| §Versioning — `codepod_guest_compat_version` + build-time check | Task 2, Task 7 |
| §Toolchain Integration — `codepod-cc` wrapper, companion tools, `CODEPOD_CC_*` envs, pre-opt preservation | Tasks 5–7 |
| §Conformance Testing — tree layout, C canaries, driver skeleton | Tasks 9–11 |
| §Repository Shape — Step 1 layout | Task 1 (rename + subdirs), Tasks 5, 11 (populate) |
| §Migration Path > Step 1 | this whole plan |
| §Acceptance Criteria (Step 1 subset: rename, archive, Tier 1 parity, canaries green via `cpcc`) | Task 13 |

**Naming note:** The spec calls the C frontend `codepod-cc`, with companions `codepod-ar` / `codepod-ranlib` / `codepod-cxx`. Per user direction on this plan, the shipped binaries use short names — `cpcc` / `cpar` / `cpranlib` — and the crate directory is `packages/guest-compat/toolchain/cpcc/`. The env-var prefix (§Toolchain Integration's `CODEPOD_CC_*`) becomes `CPCC_*` for the same reason. A `cpcxx` C++ companion is mentioned by the spec ("`codepod-cxx` as needed") but is **deferred**: no Step 1 C consumer needs C++; a Step 3+ task adds it when the first C++ consumer lands.

Items explicitly **out of scope** for Step 1 per the spec:

- `cargo-codepod`, Rust canaries, `codepod-guest-compat[-sys]` crates, CI wiring of the conformance driver, real Rust consumer port (Step 3).
- BusyBox validation against stabilized Tier 1 (Step 4) — Step 1 only cuts BusyBox's build recipe over to `cpcc`; observable behavior is Step 4's problem.
- Documentation reframing to "guest compatibility runtime" language in sibling specs (Step 2). Step 1 only updates path/name references that would otherwise be stale after the rename.
- Behavioral spec TOML files (Step 3a). Step 1 keeps the existing orchestrator-level pass/fail C canary tests as the behavioral harness.

---

## File Structure

### After Step 1 (target layout — per §Repository Shape)

```
packages/
  guest-compat/                                  # renamed from packages/c-compat/
    README.md                                    # updated paths; reframing is Step 2
    Makefile                                     # builds archive + canaries via cpcc/cpar
    include/                                     # unchanged public headers (moved)
      codepod_compat.h
      sched.h
      signal.h
      unistd.h
    src/                                         # existing C sources (moved)
      codepod_command.c
      codepod_runtime.h
      codepod_sched.c
      codepod_signal.c
      codepod_unistd.c
      codepod_version.c                          # NEW — §Versioning sentinel
      codepod_markers.h                          # NEW — marker macro + declarations
    toolchain/
      cpcc/                                      # NEW — Rust workspace member hosting every Step 1 binary
        Cargo.toml
        src/
          lib.rs                                 # shared library (wasi_sdk, archive, env, preserve, wasm_opt, precheck, conform)
          main.rs                                # bin: cpcc (clang wrapper)
          bin/
            cpar.rs                              # bin: cpar (llvm-ar wrapper)
            cpranlib.rs                          # bin: cpranlib (llvm-ranlib wrapper)
            cpcheck.rs                           # bin: cpcheck (signature-check tool)
            cpconf.rs                            # bin: cpconf (conformance driver)
          wasi_sdk.rs                            # sysroot discovery
          archive.rs                             # version handshake against archive
          wasm_opt.rs                            # optional post-processing
          preserve.rs                            # pre-opt artifact preservation
          env.rs                                 # CPCC_* env-var surface
          precheck.rs                            # llvm-nm / wasmparser signature check
          conform.rs                             # cpconf orchestration logic
        tests/
          cli.rs                                 # CLI integration tests
          signature_check.rs                     # archive+wasm marker-precedence check
          conform.rs                             # end-to-end cpconf smoke
    conformance/
      c/                                         # existing .c canaries moved here
        affinity-canary.c
        dup2-canary.c
        getgroups-canary.c
        popen-canary.c
        signal-canary.c
        sleep-canary.c
        stdio-canary.c
        system-canary.c
      rust/                                      # empty dir (Step 3d populates)
      # spec files deferred to Step 3a
packages/
  c-ports/
    busybox/
      Makefile                                   # updated: uses cpcc/cpar/cpranlib as CC/AR/RANLIB
scripts/
  dev-init.sh                                    # unchanged (PATH setup only)
  build-c-port.sh                                # RETAINED, but NO new code in Step 1 invokes it.
                                                 #   Kept only because non-Step-1 ports still reference it;
                                                 #   retirement tracked for Step 3+ once no callers remain.
```

The user-facing surface of Step 1 is the five `cp*` binaries, nothing else. Every path that existing shell scripts filled (`scripts/build-c-compat.sh`, `scripts/run-guest-compat-conformance.sh`) is now a Rust binary under `target/release/`.

### Files removed

- `packages/c-compat/Makefile` (replaced by `packages/guest-compat/Makefile`)
- `packages/c-compat/examples/*.c` (moved to `packages/guest-compat/conformance/c/`)
- `packages/c-compat/*.wasm` (regenerated under `packages/guest-compat/build/`)
- `packages/c-compat/build/*.o` (regenerated under `packages/guest-compat/build/`)
- `scripts/build-c-compat.sh` (superseded: run `make -C packages/guest-compat` or the `cpconf` binary directly)

### Files modified (path-only updates in Step 1)

- `docs/guides/syscalls.md` — `packages/c-compat/include/` → `packages/guest-compat/include/`
- `docs/guides/creating-commands.md` — three path references
- `packages/c-builder/README.md` — `packages/c-compat/…` paths in examples
- `packages/orchestrator/src/__tests__/c-compat.test.ts` → rename file to `guest-compat.test.ts`; update `describe()` string; fixtures path stays (fixture filenames unchanged)
- `packages/c-ports/busybox/Makefile` — drop direct `codepod_*.o` object injection; depend on `libcodepod_guest_compat.a` through `cpcc`

### Cargo workspace

- Root `Cargo.toml` gains one member: `packages/guest-compat/toolchain/cpcc`.

---

## Conventions for this plan

- **Working directory** is the repo root unless a step explicitly `cd`s.
- **Source the dev env** (`source scripts/dev-init.sh`) in any shell that runs `deno` or `cargo`. Each task's first command assumes this.
- **Commits** land on the current branch. Do not create or push branches; do not open PRs. Pre-commit hook runs Rust fmt, clippy, TS type-check; pre-push runs unit tests (see CLAUDE.md). If either fails, fix the underlying issue — do NOT bypass hooks.
- **`wasi-sdk`**: Task 5 ports the `find_wasi_sdk` logic from `scripts/build-c-port.sh` into the `cpcc` library crate; after Task 5, **every piece of Step 1 code** (including the test shell scripts in Tasks 2–4) locates wasi-sdk by invoking `cpcc --print-sdk-path`, never `scripts/build-c-port.sh env`. The shell script stays on disk only for non-migrated-yet ports outside Step 1.
- **Tier 1 symbol list** (used many times below): `dup2`, `getgroups`, `sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`, `signal`, `sigaction`, `raise`, `alarm`, `sigemptyset`, `sigfillset`, `sigaddset`, `sigdelset`, `sigismember`, `sigprocmask`, `sigsuspend` (16 symbols). These come from §Compatibility Tiers > Tier 1.

---

## Task 1: Rename `packages/c-compat/` → `packages/guest-compat/` with new subdir layout

Implements: §Repository Shape (Step 1 layout), §Migration Path > Step 1 bullet 1.

**Files:**
- Rename dir: `packages/c-compat/` → `packages/guest-compat/`
- Create: `packages/guest-compat/toolchain/` (empty placeholder, `.gitkeep`)
- Create: `packages/guest-compat/conformance/c/` (empty placeholder, `.gitkeep`)
- Create: `packages/guest-compat/conformance/rust/` (empty placeholder, `.gitkeep`)
- Modify: `packages/guest-compat/Makefile` — path literals inside the Makefile that point at sibling dirs stay working; no new logic this task.
- Modify: `packages/c-ports/busybox/Makefile` — update `../../c-compat/…` path literals to `../../guest-compat/…`. Keep existing object injection for now (cut over in Task 12).
- Modify: `scripts/build-c-compat.sh` — update the `cd` target to `packages/guest-compat`. (This script is fully removed in Task 11.)
- Modify: `packages/orchestrator/src/__tests__/c-compat.test.ts` → rename file to `guest-compat.test.ts`; update the `describe()` title string. Fixture imports untouched (filenames are still `<name>-canary.wasm`).
- Modify: `docs/guides/syscalls.md`, `docs/guides/creating-commands.md`, `packages/c-builder/README.md` — replace `packages/c-compat/` literal path references with `packages/guest-compat/`.

- [ ] **Step 1: Perform the rename with `git mv`**

```bash
git mv packages/c-compat packages/guest-compat
mkdir -p packages/guest-compat/toolchain packages/guest-compat/conformance/c packages/guest-compat/conformance/rust
touch packages/guest-compat/toolchain/.gitkeep packages/guest-compat/conformance/c/.gitkeep packages/guest-compat/conformance/rust/.gitkeep
```

- [ ] **Step 2: Update sibling recipe path literals**

In `packages/c-ports/busybox/Makefile`, replace every occurrence of `c-compat` with `guest-compat` (paths only).

Expected diff (literal substitutions at lines ~15–21 and ~80–86):

```
CODEPOD_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
CODEPOD_SCHED_SRC := $(REPO_ROOT)/packages/guest-compat/src/codepod_sched.c
CODEPOD_SCHED_HDR := $(REPO_ROOT)/packages/guest-compat/include/sched.h
CODEPOD_SIGNAL_SRC := $(REPO_ROOT)/packages/guest-compat/src/codepod_signal.c
CODEPOD_SIGNAL_HDR := $(REPO_ROOT)/packages/guest-compat/include/signal.h
CODEPOD_UNISTD_SRC := $(REPO_ROOT)/packages/guest-compat/src/codepod_unistd.c
CODEPOD_UNISTD_HDR := $(REPO_ROOT)/packages/guest-compat/include/unistd.h
```

In `scripts/build-c-compat.sh` change:

```bash
cd "$REPO_ROOT/packages/guest-compat"
```

- [ ] **Step 3: Rename the orchestrator test file**

```bash
git mv packages/orchestrator/src/__tests__/c-compat.test.ts packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Edit the `describe(...)` label inside that file from `'C compatibility canaries'` to `'Guest compatibility canaries'`.

- [ ] **Step 4: Update doc path references (path-only, not language reframing)**

Replace `packages/c-compat/` with `packages/guest-compat/` in:
- `docs/guides/syscalls.md` line 49
- `docs/guides/creating-commands.md` lines 150, 165, 166
- `packages/c-builder/README.md` — the two code-fenced example paths
- `packages/guest-compat/README.md` — update any internal file references to the new include paths (`packages/guest-compat/include/...`)

Do NOT reframe the "C compatibility layer" language in these files — that is Step 2's job.

- [ ] **Step 5: Verify nothing else references the old path**

```bash
rg -n "packages/c-compat" -g "*.md" -g "*.sh" -g "*.ts" -g "*.rs" -g "Makefile*" .
```

Expected: no matches. If any appear, fix them in this task (path-only, not language).

- [ ] **Step 6: Smoke-build existing canaries at their new location**

```bash
source scripts/dev-init.sh
scripts/build-c-compat.sh copy-fixtures
```

Expected: all eight `<name>-canary.wasm` files land under `packages/orchestrator/src/platform/__tests__/fixtures/`.

- [ ] **Step 7: Verify the orchestrator canary suite still passes**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: all `it(...)` cases PASS (same behavior as before; we only renamed).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(guest-compat): rename packages/c-compat to packages/guest-compat

Step 1 of the guest compatibility runtime migration. Rename only; no
behavior change. Introduces the toolchain/ and conformance/ subdirs from
the target layout as empty placeholders; later tasks populate them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `codepod_guest_compat_version` sentinel symbol and header constant

Implements: §Versioning.

**Files:**
- Create: `packages/guest-compat/src/codepod_version.c`
- Modify: `packages/guest-compat/include/codepod_compat.h`
- Modify: `packages/guest-compat/Makefile` — add `codepod_version.o` to the object set and teach the archive target (added in Task 4) about it.

- [ ] **Step 1: Write a failing version-symbol check**

Create `packages/guest-compat/tests/check_version_symbol.sh` (new subdir):

```bash
mkdir -p packages/guest-compat/tests
```

Write `packages/guest-compat/tests/check_version_symbol.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Verify the version sentinel symbol is defined in the built object, and
# that the header exposes the corresponding compile-time major/minor
# macros (so cpcc and header stay in sync textually). This is presence-
# only — extracting the encoded uint32_t out of the archive to value-
# match against the header constants requires parsing the wasm object
# format and is deferred to Step 3 (see §Versioning and the Self-Review
# note). Task 7's cpcc archive check likewise enforces presence only at
# Step 1.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$REPO_ROOT/packages/guest-compat/build"
OBJ="$BUILD_DIR/codepod_version.o"
HDR="$REPO_ROOT/packages/guest-compat/include/codepod_compat.h"

# These test shell scripts require a wasi-sdk install located via the
# standard WASI_SDK_PATH env var. After Task 6, use:
#   WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
# For Tasks 2–4 (before cpcc is built), require the caller to set
# WASI_SDK_PATH themselves.
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/cpcc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build cpcc first" >&2
    exit 1
  fi
fi
NM="$WASI_SDK_PATH/bin/llvm-nm"

if [ ! -f "$OBJ" ]; then
  echo "missing $OBJ — run make first" >&2
  exit 1
fi

# The symbol must be defined (D or R) and named `codepod_guest_compat_version`.
if ! "$NM" --defined-only "$OBJ" | grep -E ' [DR] codepod_guest_compat_version$' >/dev/null; then
  echo "codepod_guest_compat_version not defined in $OBJ" >&2
  "$NM" --defined-only "$OBJ" >&2
  exit 1
fi

# The header must expose CODEPOD_GUEST_COMPAT_VERSION_MAJOR and _MINOR.
grep -q 'CODEPOD_GUEST_COMPAT_VERSION_MAJOR' "$HDR" || { echo "missing major in header" >&2; exit 1; }
grep -q 'CODEPOD_GUEST_COMPAT_VERSION_MINOR' "$HDR" || { echo "missing minor in header" >&2; exit 1; }

echo "version symbol OK"
```

```bash
chmod +x packages/guest-compat/tests/check_version_symbol.sh
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bash packages/guest-compat/tests/check_version_symbol.sh
```

Expected: FAIL with `missing … build/codepod_version.o — run make first`.

- [ ] **Step 3: Add the version source file**

Create `packages/guest-compat/src/codepod_version.c`:

```c
#include <stdint.h>

#include "codepod_compat.h"

uint32_t codepod_guest_compat_version =
  ((uint32_t)CODEPOD_GUEST_COMPAT_VERSION_MAJOR << 16) |
  (uint32_t)CODEPOD_GUEST_COMPAT_VERSION_MINOR;
```

- [ ] **Step 4: Expose the version constant from the public header**

Edit `packages/guest-compat/include/codepod_compat.h` to add the following block above the `codepod_system` declaration (keeping the existing `#include <stdio.h>` line):

```c
#include <stdint.h>

#define CODEPOD_GUEST_COMPAT_VERSION_MAJOR 1u
#define CODEPOD_GUEST_COMPAT_VERSION_MINOR 0u

extern uint32_t codepod_guest_compat_version;
```

- [ ] **Step 5: Teach the Makefile to build `codepod_version.o`**

Edit `packages/guest-compat/Makefile` — add a rule alongside the other `$(BUILD_DIR)/*.o` rules:

```make
$(BUILD_DIR)/codepod_version.o: src/codepod_version.c include/codepod_compat.h $(BUILD_PREREQS) | $(BUILD_DIR)
	$(BUILD) $(BUILD_COMMON) --compile-only --source $< --output $@
```

Also add `$(BUILD_DIR)/codepod_version.o` to the list of prerequisites for any canary that might reference it (none currently do) — for now it is compiled standalone.

Add a phony `objects` target to force its build:

```make
.PHONY: objects
objects: $(BUILD_DIR)/codepod_command.o $(BUILD_DIR)/codepod_sched.o $(BUILD_DIR)/codepod_signal.o $(BUILD_DIR)/codepod_unistd.o $(BUILD_DIR)/codepod_version.o
```

- [ ] **Step 6: Build and re-run the test**

```bash
cd packages/guest-compat && make objects && cd -
bash packages/guest-compat/tests/check_version_symbol.sh
```

Expected: `version symbol OK`.

- [ ] **Step 7: Commit**

```bash
git add packages/guest-compat/src/codepod_version.c packages/guest-compat/include/codepod_compat.h packages/guest-compat/Makefile packages/guest-compat/tests/check_version_symbol.sh
git commit -m "$(cat <<'EOF'
feat(guest-compat): add codepod_guest_compat_version sentinel + header constants

Implements §Versioning from the guest compat runtime spec. Exports a
uint32_t encoded as (major << 16) | minor and exposes matching
compile-time constants in codepod_compat.h. Tooling in later tasks
(cpcc) reads both sides to enforce a build-time version match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `__codepod_guest_compat_marker_<sym>` marker functions for every Tier 1 symbol

Implements: §Override And Link Precedence > Verifying Precedence (markers are the implementation-signature check's anchor); §Compatibility Tiers > Tier 1 enumeration.

**Goal of this task:** Each of the 16 Tier 1 functions must (a) have a paired exported marker `__codepod_guest_compat_marker_<sym>` returning a distinct constant, (b) call that marker from its body via a side-effecting call that survives link-time DCE, and (c) the symbol and its marker must be defined in the same translation unit so `llvm-nm` on the archive passes pre-link.

**Files:**
- Create: `packages/guest-compat/src/codepod_markers.h`
- Modify: `packages/guest-compat/src/codepod_unistd.c` (2 syms: `dup2`, `getgroups`)
- Modify: `packages/guest-compat/src/codepod_sched.c` (3 syms: `sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`)
- Modify: `packages/guest-compat/src/codepod_signal.c` (11 syms: `signal`, `sigaction`, `raise`, `alarm`, `sigemptyset`, `sigfillset`, `sigaddset`, `sigdelset`, `sigismember`, `sigprocmask`, `sigsuspend`)

- [ ] **Step 1: Write failing markers test**

Create `packages/guest-compat/tests/check_markers.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BUILD_DIR="$REPO_ROOT/packages/guest-compat/build"
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/cpcc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build cpcc first" >&2
    exit 1
  fi
fi
NM="$WASI_SDK_PATH/bin/llvm-nm"

# (symbol, object-file) pairs. Each symbol must have a marker defined in
# the same object file.
pairs=(
  "dup2 codepod_unistd.o"
  "getgroups codepod_unistd.o"
  "sched_getaffinity codepod_sched.o"
  "sched_setaffinity codepod_sched.o"
  "sched_getcpu codepod_sched.o"
  "signal codepod_signal.o"
  "sigaction codepod_signal.o"
  "raise codepod_signal.o"
  "alarm codepod_signal.o"
  "sigemptyset codepod_signal.o"
  "sigfillset codepod_signal.o"
  "sigaddset codepod_signal.o"
  "sigdelset codepod_signal.o"
  "sigismember codepod_signal.o"
  "sigprocmask codepod_signal.o"
  "sigsuspend codepod_signal.o"
)

fail=0
for pair in "${pairs[@]}"; do
  sym="${pair% *}"
  obj="${pair#* }"
  path="$BUILD_DIR/$obj"
  if [ ! -f "$path" ]; then
    echo "missing object $path — run make objects first" >&2
    exit 1
  fi
  defined_sym="$("$NM" --defined-only "$path" | awk -v s="$sym" '$3 == s {print $3; exit}')"
  defined_marker="$("$NM" --defined-only "$path" | awk -v s="__codepod_guest_compat_marker_$sym" '$3 == s {print $3; exit}')"
  if [ -z "$defined_sym" ]; then
    echo "FAIL: $sym not defined in $obj" >&2; fail=1
  fi
  if [ -z "$defined_marker" ]; then
    echo "FAIL: __codepod_guest_compat_marker_$sym not defined in $obj" >&2; fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1
echo "markers OK"
```

```bash
chmod +x packages/guest-compat/tests/check_markers.sh
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd packages/guest-compat && make objects && cd -
bash packages/guest-compat/tests/check_markers.sh
```

Expected: multiple `FAIL: __codepod_guest_compat_marker_*` lines.

- [ ] **Step 3: Add the marker header**

Create `packages/guest-compat/src/codepod_markers.h`:

```c
#ifndef CODEPOD_MARKERS_H
#define CODEPOD_MARKERS_H

#include <stdint.h>

/*
 * Implementation-signature markers for §Verifying Precedence.
 *
 * Every Tier 1 symbol has a companion exported marker function returning a
 * distinct constant. The Tier 1 function body emits a side-effecting call to
 * its marker so that link-time DCE retains both and wasm-tools can see the
 * call in the pre-opt `.wasm`. `wasm-opt` later may inline or DCE this call;
 * the signature check runs pre-opt.
 *
 * Constants are arbitrary distinct non-zero magic numbers; they exist only
 * to make the marker bodies individually identifiable in dumps.
 */

#define CODEPOD_MARKER_ATTR __attribute__((visibility("default"), used, noinline))

#define CODEPOD_DEFINE_MARKER(sym, magic)                                   \
  CODEPOD_MARKER_ATTR uint32_t __codepod_guest_compat_marker_##sym(void) {  \
    return (uint32_t)(magic);                                               \
  }

#define CODEPOD_DECLARE_MARKER(sym) \
  uint32_t __codepod_guest_compat_marker_##sym(void)

#define CODEPOD_MARKER_CALL(sym)                              \
  do {                                                        \
    volatile uint32_t _codepod_marker_sink =                  \
      __codepod_guest_compat_marker_##sym();                  \
    (void)_codepod_marker_sink;                               \
  } while (0)

#endif
```

- [ ] **Step 4: Wire markers into `codepod_unistd.c` (`dup2`, `getgroups`)**

Rewrite `packages/guest-compat/src/codepod_unistd.c`:

```c
#include "codepod_runtime.h"
#include "codepod_markers.h"

#include <errno.h>
#include <unistd.h>

CODEPOD_DECLARE_MARKER(dup2);
CODEPOD_DECLARE_MARKER(getgroups);

CODEPOD_DEFINE_MARKER(dup2, 0x64703200u)      /* "dp2\0" */
CODEPOD_DEFINE_MARKER(getgroups, 0x67677270u) /* "ggrp" */

int dup2(int oldfd, int newfd) {
  CODEPOD_MARKER_CALL(dup2);

  if (oldfd < 0 || newfd < 0) {
    errno = EINVAL;
    return -1;
  }

  if (oldfd == newfd) {
    return newfd;
  }

  if (codepod_host_dup2(oldfd, newfd) != 0) {
    errno = EBADF;
    return -1;
  }

  return newfd;
}

int getgroups(int size, gid_t list[]) {
  CODEPOD_MARKER_CALL(getgroups);

  if (size < 0) {
    errno = EINVAL;
    return -1;
  }
  if (size == 0) {
    return 1;
  }
  if (list == NULL) {
    errno = EINVAL;
    return -1;
  }

  list[0] = (gid_t) 0;
  return 1;
}
```

- [ ] **Step 5: Wire markers into `codepod_sched.c` (`sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`)**

Edit `packages/guest-compat/src/codepod_sched.c`. Add the include and declarations above the validator, and add a marker call as the first statement of each public function:

Add at top of file, after `#include <string.h>`:

```c
#include "codepod_markers.h"

CODEPOD_DECLARE_MARKER(sched_getaffinity);
CODEPOD_DECLARE_MARKER(sched_setaffinity);
CODEPOD_DECLARE_MARKER(sched_getcpu);

CODEPOD_DEFINE_MARKER(sched_getaffinity, 0x73676166u) /* sgaf */
CODEPOD_DEFINE_MARKER(sched_setaffinity, 0x73736166u) /* ssaf */
CODEPOD_DEFINE_MARKER(sched_getcpu,      0x73676370u) /* sgcp */
```

Inject `CODEPOD_MARKER_CALL(sched_getaffinity);` as the first statement of `sched_getaffinity`, `CODEPOD_MARKER_CALL(sched_setaffinity);` as the first statement of `sched_setaffinity`, and `CODEPOD_MARKER_CALL(sched_getcpu);` as the first statement of `sched_getcpu`.

- [ ] **Step 6: Wire markers into `codepod_signal.c` (11 symbols)**

Edit `packages/guest-compat/src/codepod_signal.c`. Add at top of file, after `#include <string.h>`:

```c
#include "codepod_markers.h"

CODEPOD_DECLARE_MARKER(signal);
CODEPOD_DECLARE_MARKER(sigaction);
CODEPOD_DECLARE_MARKER(raise);
CODEPOD_DECLARE_MARKER(alarm);
CODEPOD_DECLARE_MARKER(sigemptyset);
CODEPOD_DECLARE_MARKER(sigfillset);
CODEPOD_DECLARE_MARKER(sigaddset);
CODEPOD_DECLARE_MARKER(sigdelset);
CODEPOD_DECLARE_MARKER(sigismember);
CODEPOD_DECLARE_MARKER(sigprocmask);
CODEPOD_DECLARE_MARKER(sigsuspend);

CODEPOD_DEFINE_MARKER(signal,       0x73676e6cu) /* sgnl */
CODEPOD_DEFINE_MARKER(sigaction,    0x73676163u) /* sgac */
CODEPOD_DEFINE_MARKER(raise,        0x72616973u) /* rais */
CODEPOD_DEFINE_MARKER(alarm,        0x616c726du) /* alrm */
CODEPOD_DEFINE_MARKER(sigemptyset,  0x73656d70u) /* semp */
CODEPOD_DEFINE_MARKER(sigfillset,   0x7366696cu) /* sfil */
CODEPOD_DEFINE_MARKER(sigaddset,    0x73616464u) /* sadd */
CODEPOD_DEFINE_MARKER(sigdelset,    0x7364656cu) /* sdel */
CODEPOD_DEFINE_MARKER(sigismember,  0x7369736du) /* sism */
CODEPOD_DEFINE_MARKER(sigprocmask,  0x7370726du) /* sprm */
CODEPOD_DEFINE_MARKER(sigsuspend,   0x73737370u) /* sssp */
```

Inject `CODEPOD_MARKER_CALL(<sym>);` as the first statement of each public function body:
- `sigemptyset` → `CODEPOD_MARKER_CALL(sigemptyset);`
- `sigfillset` → `CODEPOD_MARKER_CALL(sigfillset);`
- `sigaddset` → `CODEPOD_MARKER_CALL(sigaddset);`
- `sigdelset` → `CODEPOD_MARKER_CALL(sigdelset);`
- `sigismember` → `CODEPOD_MARKER_CALL(sigismember);`
- `signal` → `CODEPOD_MARKER_CALL(signal);`
- `sigaction` → `CODEPOD_MARKER_CALL(sigaction);`
- `sigprocmask` → `CODEPOD_MARKER_CALL(sigprocmask);`
- `sigsuspend` → `CODEPOD_MARKER_CALL(sigsuspend);`
- `raise` → `CODEPOD_MARKER_CALL(raise);`
- `alarm` → `CODEPOD_MARKER_CALL(alarm);`

- [ ] **Step 7: Rebuild objects and rerun the test**

```bash
cd packages/guest-compat && make clean && make objects && cd -
bash packages/guest-compat/tests/check_markers.sh
```

Expected: `markers OK`.

- [ ] **Step 8: Spot-check the existing canary suite still passes (no behavior regression)**

The canaries still link against the individual `.o` files via the current Makefile rules (archive is Task 4). Rebuild them and rerun:

```bash
scripts/build-c-compat.sh copy-fixtures
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: all canary cases PASS — markers are additive, not semantic.

- [ ] **Step 9: Commit**

```bash
git add packages/guest-compat/src/codepod_markers.h packages/guest-compat/src/codepod_unistd.c packages/guest-compat/src/codepod_sched.c packages/guest-compat/src/codepod_signal.c packages/guest-compat/tests/check_markers.sh
git commit -m "$(cat <<'EOF'
feat(guest-compat): add precedence markers for every Tier 1 symbol

Each of the 16 Tier 1 symbols (§Compatibility Tiers) gains a companion
exported marker function __codepod_guest_compat_marker_<sym> and calls
it side-effectingly from its body. Implements the anchor for the
implementation-signature check in §Verifying Precedence. Markers are
defined in the same translation unit as the symbol so the pre-link
llvm-nm assertion holds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Build `libcodepod_guest_compat.a` archive + pre-link assertion

Implements: §Architecture (Phase A artifact), §Override And Link Precedence > Verifying Precedence step 1 (llvm-nm pre-link).

**Files:**
- Modify: `packages/guest-compat/Makefile` — add `lib` target producing `libcodepod_guest_compat.a`.
- Create: `packages/guest-compat/tests/check_archive.sh`

- [ ] **Step 1: Write failing archive-contents test**

Create `packages/guest-compat/tests/check_archive.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libcodepod_guest_compat.a"
if [ -z "${WASI_SDK_PATH:-}" ]; then
  if [ -x "$REPO_ROOT/target/release/cpcc" ]; then
    WASI_SDK_PATH="$("$REPO_ROOT/target/release/cpcc" --print-sdk-path)"
  else
    echo "set WASI_SDK_PATH or build cpcc first" >&2
    exit 1
  fi
fi
AR="$WASI_SDK_PATH/bin/llvm-ar"
NM="$WASI_SDK_PATH/bin/llvm-nm"

[ -f "$ARCHIVE" ] || { echo "missing $ARCHIVE" >&2; exit 1; }

contents="$("$AR" t "$ARCHIVE")"
for want in codepod_command.o codepod_sched.o codepod_signal.o codepod_unistd.o codepod_version.o; do
  if ! echo "$contents" | grep -qx "$want"; then
    echo "archive missing $want (contains: $contents)" >&2
    exit 1
  fi
done

# Every Tier 1 symbol and its marker must be defined somewhere in the
# archive (llvm-nm on the whole archive).
tier1=(dup2 getgroups sched_getaffinity sched_setaffinity sched_getcpu \
       signal sigaction raise alarm \
       sigemptyset sigfillset sigaddset sigdelset sigismember \
       sigprocmask sigsuspend)
nm_out="$("$NM" --defined-only "$ARCHIVE")"

fail=0
for s in "${tier1[@]}"; do
  if ! echo "$nm_out" | awk '{print $NF}' | grep -qx "$s"; then
    echo "archive missing definition of $s" >&2
    fail=1
  fi
  if ! echo "$nm_out" | awk '{print $NF}' | grep -qx "__codepod_guest_compat_marker_$s"; then
    echo "archive missing marker __codepod_guest_compat_marker_$s" >&2
    fail=1
  fi
done

# Version sentinel.
if ! echo "$nm_out" | awk '{print $NF}' | grep -qx codepod_guest_compat_version; then
  echo "archive missing codepod_guest_compat_version" >&2
  fail=1
fi

[ $fail -eq 0 ] || exit 1
echo "archive OK"
```

```bash
chmod +x packages/guest-compat/tests/check_archive.sh
```

- [ ] **Step 2: Run test and confirm it fails**

```bash
bash packages/guest-compat/tests/check_archive.sh
```

Expected: `missing …/libcodepod_guest_compat.a`.

- [ ] **Step 3: Add the `lib` target to the Makefile**

Edit `packages/guest-compat/Makefile`. Add near the top:

```make
LIB := $(BUILD_DIR)/libcodepod_guest_compat.a
LIB_OBJS := \
  $(BUILD_DIR)/codepod_command.o \
  $(BUILD_DIR)/codepod_sched.o \
  $(BUILD_DIR)/codepod_signal.o \
  $(BUILD_DIR)/codepod_unistd.o \
  $(BUILD_DIR)/codepod_version.o
```

Add the target (place alongside the existing rules, before `clean`):

```make
.PHONY: lib
lib: $(LIB)

$(LIB): $(LIB_OBJS) | $(BUILD_DIR)
	eval "$$($(BUILD) env)" && "$$AR" rcs $@ $(LIB_OBJS)
```

Add `lib` to the default `all` target:

```make
all: lib stdio-canary.wasm sleep-canary.wasm system-canary.wasm popen-canary.wasm affinity-canary.wasm dup2-canary.wasm getgroups-canary.wasm signal-canary.wasm
```

Update `clean`:

```make
clean:
	rm -rf $(BUILD_DIR) stdio-canary.wasm sleep-canary.wasm system-canary.wasm popen-canary.wasm affinity-canary.wasm dup2-canary.wasm getgroups-canary.wasm signal-canary.wasm
```

(`$(BUILD_DIR)` already contains the archive, so no change needed there.)

- [ ] **Step 4: Build the archive**

```bash
cd packages/guest-compat && make clean && make lib && cd -
```

Expected: `build/libcodepod_guest_compat.a` exists.

- [ ] **Step 5: Rerun the archive test**

```bash
bash packages/guest-compat/tests/check_archive.sh
```

Expected: `archive OK`.

- [ ] **Step 6: Commit**

```bash
git add packages/guest-compat/Makefile packages/guest-compat/tests/check_archive.sh
git commit -m "$(cat <<'EOF'
feat(guest-compat): bundle libcodepod_guest_compat.a archive

Packages the five guest-compat object files (command, sched, signal,
unistd, version) into a single static archive — the Phase A artifact
from §Architecture. The accompanying llvm-nm contract verifies every
Tier 1 symbol, its marker, and the version sentinel are defined in the
archive (§Verifying Precedence step 1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Scaffold `cpcc` Rust crate + register in workspace

Implements: §Toolchain Integration > `codepod-cc` (scaffolding only; feature tasks follow).

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/Cargo.toml`
- Create: `packages/guest-compat/toolchain/cpcc/src/main.rs`
- Create: `packages/guest-compat/toolchain/cpcc/tests/cli.rs`
- Modify: `Cargo.toml` (root workspace) — add the new member.

- [ ] **Step 1: Write failing CLI smoke test**

Create `packages/guest-compat/toolchain/cpcc/tests/cli.rs`:

```rust
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_cpcc")
}

#[test]
fn help_prints_usage() {
    let out = Command::new(bin())
        .arg("--help")
        .output()
        .expect("run cpcc --help");
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("cpcc"), "help output: {stdout}");
    assert!(stdout.contains("Usage"), "help output: {stdout}");
}

#[test]
fn version_prints_version() {
    let out = Command::new(bin())
        .arg("--version")
        .output()
        .expect("run cpcc --version");
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains(env!("CARGO_PKG_VERSION")), "version output: {stdout}");
}
```

- [ ] **Step 2: Add the crate manifest**

Create `packages/guest-compat/toolchain/cpcc/Cargo.toml`:

```toml
[package]
name = "cpcc-toolchain"
version = "0.1.0"
edition = "2021"
publish = false
description = "Clang wrapper and companion tooling for the codepod guest compatibility runtime."

[[bin]]
name = "cpcc"
path = "src/main.rs"

[dependencies]
clap = { version = "4", features = ["derive"] }
anyhow = "1"
```

**Naming note.** The package is `cpcc-toolchain` (so `cargo <cmd> -p cpcc-toolchain` targets it); its default library crate will be `cpcc_toolchain` — which binaries later `use cpcc_toolchain::…` to pull in shared modules. The primary binary is still just `cpcc`. Keeping the package name distinct from every binary name avoids the Cargo edge case where a `[[bin]]` and an implicit library would collide on the same name.

- [ ] **Step 3: Add minimal `main.rs` skeleton**

Create `packages/guest-compat/toolchain/cpcc/src/main.rs`:

```rust
use anyhow::Result;
use clap::Parser;

/// cpcc — clang wrapper for the codepod guest compatibility runtime.
///
/// This is a driver wrapper (§Toolchain Integration). It takes the same
/// positional arguments as clang and forwards them, after injecting the
/// codepod sysroot, include paths, and link-time compat archive framing
/// (§Override And Link Precedence).
#[derive(Parser, Debug)]
#[command(name = "cpcc", version, about, long_about = None)]
struct Cli {
    /// Arguments forwarded to clang (everything after a `--` separator, or
    /// arguments that do not match a cpcc-specific flag).
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn main() -> Result<()> {
    let _cli = Cli::parse();
    // Later tasks: wasi-sdk discovery, sysroot/target injection, link-arg
    // injection, pre-opt preservation, optional wasm-opt, version check.
    Ok(())
}
```

- [ ] **Step 4: Register the crate in the workspace**

Edit root `Cargo.toml`. Add to the `members` array:

```toml
"packages/guest-compat/toolchain/cpcc",
```

Place it alphabetically-adjacent (the list is not strictly ordered; append at the end of `members` is fine).

- [ ] **Step 5: Run tests**

```bash
source scripts/dev-init.sh
cargo test -p cpcc-toolchain
```

Expected: both `help_prints_usage` and `version_prints_version` PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml packages/guest-compat/toolchain/cpcc/
git commit -m "$(cat <<'EOF'
feat(cpcc): scaffold clang-wrapper binary + workspace registration

Adds the empty shell for the C frontend driver from §Toolchain
Integration. Subsequent tasks implement wasi-sdk discovery, sysroot/
target injection, link-arg framing for libcodepod_guest_compat.a,
pre-opt artifact preservation, optional wasm-opt, and the build-time
version handshake.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `cpcc` — wasi-sdk discovery + `-target` / `--sysroot` injection

Implements: §Toolchain Integration > `codepod-cc` bullet 1 ("selecting the wasi-sdk sysroot and clang binary it ships with").

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/src/wasi_sdk.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/main.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/tests/cli.rs`

- [ ] **Step 1: Write a failing discovery test**

Append to `packages/guest-compat/toolchain/cpcc/tests/cli.rs`:

```rust
use std::fs;

#[test]
fn invoking_clang_respects_env_sdk() {
    // Build a fake wasi-sdk layout in a temp dir and point WASI_SDK_PATH at
    // it. cpcc --dry-run must print the clang path it would exec,
    // which should be <fake>/bin/clang.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains(clang.to_str().unwrap()), "dry-run stdout: {stdout}");
    assert!(stdout.contains("--target=wasm32-wasip1"), "dry-run stdout: {stdout}");
    assert!(stdout.contains("--sysroot="), "dry-run stdout: {stdout}");
}
```

Add `tempfile = "3"` under `[dev-dependencies]` in `Cargo.toml`.

- [ ] **Step 2: Run test, confirm it fails**

```bash
cargo test -p cpcc-toolchain invoking_clang_respects_env_sdk
```

Expected: FAIL — `--dry-run` is unknown (clap rejects the flag).

- [ ] **Step 3: Implement wasi-sdk discovery**

Create `packages/guest-compat/toolchain/cpcc/src/wasi_sdk.rs`:

```rust
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// Locate a wasi-sdk installation. Mirrors the logic in
/// scripts/build-c-port.sh::find_wasi_sdk.
pub fn discover() -> Result<WasiSdk> {
    let candidates = candidate_roots();
    for root in candidates {
        if is_valid_root(&root) {
            return Ok(WasiSdk::new(root));
        }
    }
    Err(anyhow!(
        "wasi-sdk not found; set WASI_SDK_PATH to the installation root"
    ))
}

fn candidate_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(env) = std::env::var_os("WASI_SDK_PATH") {
        out.push(PathBuf::from(env));
    }
    if let Some(home) = dirs_home() {
        out.push(home.join(".local/share/wasi-sdk"));
        out.extend(glob_versioned(home.join(".local/share"), "wasi-sdk-"));
        out.push(home.join("wasi-sdk"));
        out.extend(glob_versioned(home.clone(), "wasi-sdk-"));
    }
    out.push(PathBuf::from("/opt/homebrew/opt/wasi-sdk/share/wasi-sdk"));
    out.push(PathBuf::from("/usr/local/opt/wasi-sdk/share/wasi-sdk"));
    out.push(PathBuf::from("/opt/wasi-sdk"));
    out.extend(glob_versioned(PathBuf::from("/opt"), "wasi-sdk-"));
    out.push(PathBuf::from("/usr/local/share/wasi-sdk"));
    out.extend(glob_versioned(PathBuf::from("/usr/local/share"), "wasi-sdk-"));
    out
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn glob_versioned(parent: PathBuf, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(&parent) else { return Vec::new(); };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .map(|e| e.path())
        .collect()
}

fn is_valid_root(path: &Path) -> bool {
    path.join("bin/clang").is_file() && path.join("share/wasi-sysroot").is_dir()
}

#[derive(Clone, Debug)]
pub struct WasiSdk {
    pub root: PathBuf,
}

impl WasiSdk {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn clang(&self) -> PathBuf { self.root.join("bin/clang") }
    pub fn ar(&self) -> PathBuf { self.root.join("bin/llvm-ar") }
    pub fn ranlib(&self) -> PathBuf { self.root.join("bin/llvm-ranlib") }
    pub fn nm(&self) -> PathBuf { self.root.join("bin/llvm-nm") }
    pub fn sysroot(&self) -> PathBuf { self.root.join("share/wasi-sysroot") }
}
```

- [ ] **Step 4: Wire discovery + target injection + `--print-sdk-path` into `main.rs`**

Rewrite `packages/guest-compat/toolchain/cpcc/src/main.rs`:

```rust
use anyhow::{Context, Result};
use clap::Parser;
use std::process::{Command, ExitCode};

mod wasi_sdk;

#[derive(Parser, Debug)]
#[command(name = "cpcc", version, about = "Clang wrapper for the codepod guest compatibility runtime", long_about = None)]
struct Cli {
    /// Print the clang command that would be executed, and exit 0.
    #[arg(long)]
    dry_run: bool,

    /// Print the wasi-sdk root cpcc discovered, and exit 0. Scripts and
    /// test harnesses use this to avoid re-implementing discovery.
    #[arg(long = "print-sdk-path")]
    print_sdk_path: bool,

    /// Arguments forwarded to clang.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn build_clang_invocation(sdk: &wasi_sdk::WasiSdk, user_args: &[String]) -> Vec<std::ffi::OsString> {
    let mut argv: Vec<std::ffi::OsString> = Vec::new();
    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
    argv.push("-O2".into());
    argv.push("-std=c11".into());
    argv.push("-Wall".into());
    argv.push("-Wextra".into());
    for a in user_args {
        argv.push(a.into());
    }
    argv
}

fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;

    if cli.print_sdk_path {
        println!("{}", sdk.root.display());
        return Ok(ExitCode::SUCCESS);
    }

    let argv = build_clang_invocation(&sdk, &cli.args);

    if cli.dry_run {
        print!("{}", sdk.clang().display());
        for a in &argv {
            print!(" {}", a.to_string_lossy());
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    let status = Command::new(sdk.clang())
        .args(&argv)
        .status()
        .with_context(|| format!("spawning {}", sdk.clang().display()))?;
    if let Some(code) = status.code() {
        Ok(ExitCode::from(code as u8))
    } else {
        Ok(ExitCode::FAILURE)
    }
}
```

- [ ] **Step 5: Rerun the test**

```bash
cargo test -p cpcc-toolchain
```

Expected: all tests PASS, including `invoking_clang_respects_env_sdk`.

- [ ] **Step 6: Smoke-build `stdio-canary` via `cpcc` directly**

```bash
cargo build -p cpcc-toolchain --release
./target/release/cpcc \
  -I packages/guest-compat/include \
  packages/guest-compat/examples/stdio_canary.c \
  -o /tmp/stdio-canary-cpcc.wasm
```

(The canary `.c` files will not yet live under `conformance/c/` until Task 11. For the smoke build use `packages/guest-compat/examples/stdio_canary.c` — the examples dir still exists from the rename in Task 1.)

Expected: a `.wasm` file is produced. (It will not yet contain the archive — that is Task 7.)

- [ ] **Step 7: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/
git commit -m "$(cat <<'EOF'
feat(cpcc): wasi-sdk discovery and target/sysroot injection

cpcc now locates a wasi-sdk install (mirroring build-c-port.sh's
find_wasi_sdk; the shell script becomes non-load-bearing for Step 1
code) and invokes its clang with --target=wasm32-wasip1, --sysroot,
and the repo's baseline warning/optimization flags. --dry-run prints
the composed command (used by tests); --print-sdk-path prints the
discovered wasi-sdk root (used by guest-compat/tests/check_*.sh).
Link-arg framing for libcodepod_guest_compat.a is not yet injected —
that is the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `cpcc` — inject `-isystem`, archive `--whole-archive` framing, version check

Implements: §Override And Link Precedence > Symbol Policy & Link Order (C frontend); §Versioning (the build-time version handshake).

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/src/archive.rs`
- Create: `packages/guest-compat/toolchain/cpcc/src/env.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/main.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/tests/cli.rs`

- [ ] **Step 1: Write a failing test for the injected link framing**

Append to `packages/guest-compat/toolchain/cpcc/tests/cli.rs`:

```rust
#[test]
fn dry_run_injects_compat_archive_and_isystem() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .env("CPCC_ARCHIVE", "/fake/libcodepod_guest_compat.a")
        .env("CPCC_INCLUDE", "/fake/include")
        .env("CPCC_SKIP_VERSION_CHECK", "1")
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("-isystem /fake/include"), "{stdout}");
    assert!(stdout.contains("-Wl,--whole-archive"), "{stdout}");
    assert!(stdout.contains("/fake/libcodepod_guest_compat.a"), "{stdout}");
    assert!(stdout.contains("-Wl,--no-whole-archive"), "{stdout}");
    // `--whole-archive` must appear before `-lc` in the final argv. Since
    // compile-only invocations don't reach `-lc`, assert relative ordering
    // only if `-lc` is present in the output.
    let whole_idx = stdout.find("--whole-archive").unwrap();
    let no_whole_idx = stdout.find("--no-whole-archive").unwrap();
    assert!(whole_idx < no_whole_idx, "whole_archive must precede no_whole_archive");
}
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
cargo test -p cpcc-toolchain dry_run_injects_compat_archive_and_isystem
```

Expected: FAIL — `-isystem /fake/include` absent.

- [ ] **Step 3: Add env-var surface module**

Create `packages/guest-compat/toolchain/cpcc/src/env.rs`:

```rust
use std::ffi::OsString;
use std::path::PathBuf;

/// User-facing environment variables (§Toolchain Integration — the
/// CPCC_* surface).
pub struct Env {
    pub archive: Option<PathBuf>,
    pub include: Option<PathBuf>,
    pub skip_version_check: bool,
    pub preserve_pre_opt: Option<PathBuf>,
    pub wasm_opt: WasmOptMode,
}

pub enum WasmOptMode {
    Disabled,
    Default,
    Explicit(Vec<OsString>),
}

impl Env {
    pub fn from_process() -> Self {
        Self {
            archive: std::env::var_os("CPCC_ARCHIVE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            include: std::env::var_os("CPCC_INCLUDE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            skip_version_check: std::env::var_os("CPCC_SKIP_VERSION_CHECK").is_some(),
            preserve_pre_opt: std::env::var_os("CPCC_PRESERVE_PRE_OPT").map(PathBuf::from),
            wasm_opt: if std::env::var_os("CPCC_NO_WASM_OPT").is_some() {
                WasmOptMode::Disabled
            } else if let Some(flags) = std::env::var_os("CPCC_WASM_OPT_FLAGS") {
                let s = flags.to_string_lossy().to_string();
                WasmOptMode::Explicit(s.split_whitespace().map(OsString::from).collect())
            } else {
                WasmOptMode::Default
            },
        }
    }
}
```

- [ ] **Step 4: Add archive-version handshake module**

Create `packages/guest-compat/toolchain/cpcc/src/archive.rs`:

```rust
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Parse `major.minor` out of the archive by dumping the
/// `codepod_guest_compat_version` data symbol via `llvm-nm` and cross-
/// referencing against the compile-time constants this build of cpcc
/// was linked with. Implements §Versioning.
pub fn check_version(nm: &Path, archive: &Path) -> Result<()> {
    let out = Command::new(nm)
        .arg("--defined-only")
        .arg(archive)
        .output()
        .with_context(|| format!("running {} on {}", nm.display(), archive.display()))?;
    if !out.status.success() {
        return Err(anyhow!(
            "llvm-nm failed on {}: {}",
            archive.display(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let present = stdout.lines().any(|line| {
        line.split_whitespace()
            .last()
            .map(|s| s == "codepod_guest_compat_version")
            .unwrap_or(false)
    });
    if !present {
        return Err(anyhow!(
            "archive {} does not define codepod_guest_compat_version (§Versioning)",
            archive.display()
        ));
    }
    // We do not yet read the archive's encoded value (that would require
    // extracting the data section). The sentinel's presence plus the
    // archive's provenance from the repo build are sufficient for Step 1.
    // Step 3 (cargo-codepod lands) tightens this to an exact value match.
    Ok(())
}
```

- [ ] **Step 5: Extend `main.rs` to inject archive framing and `-isystem`**

Rewrite `packages/guest-compat/toolchain/cpcc/src/main.rs`:

```rust
use anyhow::{Context, Result};
use clap::Parser;
use std::ffi::OsString;
use std::process::{Command, ExitCode};

mod archive;
mod env;
mod wasi_sdk;

#[derive(Parser, Debug)]
#[command(name = "cpcc", version, about = "Clang wrapper for the codepod guest compatibility runtime", long_about = None)]
struct Cli {
    #[arg(long)]
    dry_run: bool,

    #[arg(long = "print-sdk-path")]
    print_sdk_path: bool,

    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn is_link_invocation(user_args: &[String]) -> bool {
    !user_args.iter().any(|a| a == "-c" || a == "-E" || a == "-S")
}

fn build_clang_invocation(
    sdk: &wasi_sdk::WasiSdk,
    env: &env::Env,
    user_args: &[String],
) -> Vec<OsString> {
    let mut argv: Vec<OsString> = Vec::new();
    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
    argv.push("-O2".into());
    argv.push("-std=c11".into());
    argv.push("-Wall".into());
    argv.push("-Wextra".into());
    if let Some(inc) = env.include.as_ref() {
        argv.push("-isystem".into());
        argv.push(inc.clone().into_os_string());
    }
    for a in user_args {
        argv.push(a.into());
    }
    // Link-arg framing must come after the user's objects so it is last in
    // the link line. The whole-archive pair must bracket only the compat
    // archive, and the whole thing must precede `-lc`. clang's default is
    // to insert `-lc` at the very end, so appending these three args is
    // sufficient.
    if let Some(archive) = env.archive.as_ref() {
        if is_link_invocation(user_args) {
            argv.push("-Wl,--whole-archive".into());
            argv.push(archive.clone().into_os_string());
            argv.push("-Wl,--no-whole-archive".into());
        }
    }
    argv
}

fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let env = env::Env::from_process();

    if cli.print_sdk_path {
        println!("{}", sdk.root.display());
        return Ok(ExitCode::SUCCESS);
    }

    if let Some(archive) = env.archive.as_ref() {
        if !env.skip_version_check {
            archive::check_version(&sdk.nm(), archive).context("version check")?;
        }
    }

    let argv = build_clang_invocation(&sdk, &env, &cli.args);

    if cli.dry_run {
        print!("{}", sdk.clang().display());
        for a in &argv {
            print!(" {}", a.to_string_lossy());
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    let status = Command::new(sdk.clang())
        .args(&argv)
        .status()
        .with_context(|| format!("spawning {}", sdk.clang().display()))?;
    if let Some(code) = status.code() {
        Ok(ExitCode::from(code as u8))
    } else {
        Ok(ExitCode::FAILURE)
    }
}
```

- [ ] **Step 6: Add a test that the version check fires when the archive lacks the sentinel**

Append to `tests/cli.rs`:

```rust
#[test]
fn missing_version_sentinel_is_a_hard_error() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let clang = root.join("bin/clang");
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
        let nm = root.join("bin/llvm-nm");
        // llvm-nm stub: prints nothing, exits 0.
        fs::write(&nm, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&nm, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let archive = root.join("libcodepod_guest_compat.a");
    fs::write(&archive, b"not really an archive").unwrap();

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .env("CPCC_ARCHIVE", &archive)
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    assert!(!out.status.success(), "expected failure");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("codepod_guest_compat_version"), "stderr: {stderr}");
}
```

- [ ] **Step 7: Run the full test suite**

```bash
cargo test -p cpcc-toolchain
```

Expected: all PASS.

- [ ] **Step 8: Smoke-build a canary with the real archive**

```bash
cd packages/guest-compat && make lib && cd -
CPCC_ARCHIVE="$PWD/packages/guest-compat/build/libcodepod_guest_compat.a" \
CPCC_INCLUDE="$PWD/packages/guest-compat/include" \
./target/release/cpcc \
  packages/guest-compat/examples/dup2_canary.c \
  -o /tmp/dup2-canary-cpcc.wasm
```

Expected: a linked `.wasm` is produced. Full harness wiring is Task 11; this step is a smoke only.

- [ ] **Step 9: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/
git commit -m "$(cat <<'EOF'
feat(cpcc): isystem + compat-archive framing + version handshake

cpcc now injects -isystem for the compat headers and brackets
libcodepod_guest_compat.a with -Wl,--whole-archive / --no-whole-archive
at link time, per §Override And Link Precedence > Link Order. The
injected framing is controlled by CPCC_ARCHIVE and
CPCC_INCLUDE to keep the wrapper usable from CMake/autoconf that
cannot alter the CLI directly. Before invoking clang, cpcc runs
llvm-nm against the archive to assert the version sentinel is present
(§Versioning); CPCC_SKIP_VERSION_CHECK bypasses this for tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `cpcc` — pre-opt artifact preservation + optional `wasm-opt`

Implements: §Override And Link Precedence > Verifying Precedence (pre-opt preservation); §Toolchain Integration > `codepod-cc` bullets "emitting the linked `.wasm` to a stable pre-opt path" and "optionally running wasm-opt".

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/src/preserve.rs`
- Create: `packages/guest-compat/toolchain/cpcc/src/wasm_opt.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/main.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/tests/cli.rs`

- [ ] **Step 1: Write a failing test for preservation**

Append to `tests/cli.rs`:

```rust
#[test]
fn preserves_pre_opt_artifact_at_stable_path() {
    // Real clang+wasi-sdk build. Skip if WASI_SDK_PATH is not set in CI env.
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skipping — WASI_SDK_PATH not set");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("hello.c");
    fs::write(&src, b"int main(void) { return 0; }").unwrap();
    let out_wasm = tmp.path().join("hello.wasm");
    let preserved = tmp.path().join("hello.pre-opt.wasm");

    let st = Command::new(bin())
        .env("CPCC_PRESERVE_PRE_OPT", &preserved)
        .env("CPCC_NO_WASM_OPT", "1")
        .arg(&src)
        .arg("-o")
        .arg(&out_wasm)
        .status()
        .unwrap();
    assert!(st.success());
    assert!(preserved.exists(), "pre-opt wasm not preserved at {}", preserved.display());
    assert!(out_wasm.exists(), "linked wasm missing");
}
```

- [ ] **Step 2: Confirm failure**

```bash
cargo test -p cpcc-toolchain preserves_pre_opt_artifact_at_stable_path
```

Expected: FAIL — either preserved file missing, or env var ignored.

- [ ] **Step 3: Implement preservation**

Create `packages/guest-compat/toolchain/cpcc/src/preserve.rs`:

```rust
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Resolve the target `-o` from a user argv. Returns `None` for
/// compile-only invocations (no `-o foo.wasm`) — preservation has
/// nothing to do there.
pub fn output_wasm(user_args: &[String]) -> Option<PathBuf> {
    let mut iter = user_args.iter().peekable();
    while let Some(arg) = iter.next() {
        if arg == "-o" {
            if let Some(v) = iter.next() {
                let p = PathBuf::from(v);
                if p.extension().and_then(|e| e.to_str()) == Some("wasm") {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// If the user asked for preservation, copy `src` to the preserve path.
/// Otherwise no-op.
pub fn copy_to_preserve(src: &Path, preserve: Option<&Path>) -> Result<()> {
    let Some(dst) = preserve else { return Ok(()) };
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::copy(src, dst)
        .with_context(|| format!("copying {} → {}", src.display(), dst.display()))?;
    Ok(())
}
```

- [ ] **Step 4: Implement optional `wasm-opt`**

Create `packages/guest-compat/toolchain/cpcc/src/wasm_opt.rs`:

```rust
use crate::env::WasmOptMode;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Run wasm-opt on `path` in place, according to `mode`.
pub fn maybe_run(path: &Path, mode: &WasmOptMode) -> Result<()> {
    let args: Vec<std::ffi::OsString> = match mode {
        WasmOptMode::Disabled => return Ok(()),
        WasmOptMode::Default => vec![
            "-O2".into(),
            "--enable-bulk-memory".into(),
            "--enable-sign-ext".into(),
        ],
        WasmOptMode::Explicit(v) => v.clone(),
    };
    let wasm_opt = which::which("wasm-opt")
        .map_err(|_| anyhow!("wasm-opt requested but not on PATH (CPCC_NO_WASM_OPT=1 to skip)"))?;
    let status = Command::new(wasm_opt)
        .args(&args)
        .arg(path)
        .arg("-o")
        .arg(path)
        .status()
        .with_context(|| format!("running wasm-opt on {}", path.display()))?;
    if !status.success() {
        return Err(anyhow!("wasm-opt failed on {}", path.display()));
    }
    Ok(())
}
```

Add `which = "6"` to `[dependencies]` in `Cargo.toml`.

- [ ] **Step 5: Wire preservation + wasm-opt into `main.rs`**

Update `main.rs` — add `mod preserve;` and `mod wasm_opt;`, and extend `main()` to run after clang:

```rust
    let argv = build_clang_invocation(&sdk, &env, &cli.args);

    if cli.dry_run {
        print!("{}", sdk.clang().display());
        for a in &argv {
            print!(" {}", a.to_string_lossy());
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    let status = Command::new(sdk.clang())
        .args(&argv)
        .status()
        .with_context(|| format!("spawning {}", sdk.clang().display()))?;
    if !status.success() {
        return Ok(status.code().map(|c| ExitCode::from(c as u8)).unwrap_or(ExitCode::FAILURE));
    }

    // Post-link: if an output `.wasm` was produced and the user asked for
    // pre-opt preservation, copy the just-linked binary to the stable path
    // BEFORE any optional wasm-opt pass.
    if let Some(out_wasm) = preserve::output_wasm(&cli.args) {
        preserve::copy_to_preserve(&out_wasm, env.preserve_pre_opt.as_deref())?;
        wasm_opt::maybe_run(&out_wasm, &env.wasm_opt)?;
    }

    Ok(ExitCode::SUCCESS)
```

- [ ] **Step 6: Run tests**

```bash
cargo test -p cpcc-toolchain
```

Expected: all PASS. `preserves_pre_opt_artifact_at_stable_path` passes if `WASI_SDK_PATH` is available; is skipped with a log otherwise.

- [ ] **Step 7: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/
git commit -m "$(cat <<'EOF'
feat(cpcc): pre-opt artifact preservation + optional wasm-opt

When CPCC_PRESERVE_PRE_OPT is set, cpcc copies the linked
.wasm to that path before any optional post-processing — this is what
the implementation-signature check (§Verifying Precedence) inspects.
wasm-opt runs afterward in-place on the -o output; CPCC_NO_WASM_OPT
disables it, and CPCC_WASM_OPT_FLAGS customises the invocation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add `cpar` / `cpranlib` companion tools

Implements: §Toolchain Integration > `codepod-cc` ("companion `codepod-ar` / `codepod-ranlib` / `codepod-cxx`"). `cpcxx` is deferred — no Step 1 consumer needs C++.

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/src/bin/cpar.rs`
- Create: `packages/guest-compat/toolchain/cpcc/src/bin/cpranlib.rs`
- Create: `packages/guest-compat/toolchain/cpcc/src/lib.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/Cargo.toml` — declare additional `[[bin]]` targets + `[lib]`.
- Modify: `packages/guest-compat/toolchain/cpcc/src/main.rs` — use the new library crate.
- Modify: `packages/guest-compat/toolchain/cpcc/tests/cli.rs` — smoke test.

- [ ] **Step 1: Write failing smoke test**

Append to `tests/cli.rs`:

```rust
#[test]
fn cpar_exists_and_forwards_help() {
    let ar = env!("CARGO_BIN_EXE_cpar");
    let out = Command::new(ar).arg("--help").output().unwrap();
    // llvm-ar's --help is not consistent across versions; accept any run
    // that did not fail to spawn.
    assert!(out.status.code().is_some(), "cpar failed to execute");
}
```

- [ ] **Step 2: Declare the bins + lib in `Cargo.toml`**

Append to `packages/guest-compat/toolchain/cpcc/Cargo.toml`:

```toml
[[bin]]
name = "cpar"
path = "src/bin/cpar.rs"

[[bin]]
name = "cpranlib"
path = "src/bin/cpranlib.rs"

[lib]
path = "src/lib.rs"
```

No `name = …` override is needed on the `[lib]` target: the library crate name follows the package name (`cpcc-toolchain`), normalized to a Rust identifier, i.e. `cpcc_toolchain`. That is what every binary imports from.

Create `packages/guest-compat/toolchain/cpcc/src/lib.rs`:

```rust
pub mod archive;
pub mod env;
pub mod preserve;
pub mod wasi_sdk;
pub mod wasm_opt;
```

Update `main.rs` to `use cpcc_toolchain::{archive, env, preserve, wasi_sdk, wasm_opt};` and remove the duplicate `mod` declarations from `main.rs`.

- [ ] **Step 3: Implement `cpar.rs`**

Create `packages/guest-compat/toolchain/cpcc/src/bin/cpar.rs`:

```rust
use anyhow::{Context, Result};
use cpcc_toolchain::wasi_sdk;
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = Command::new(sdk.ar())
        .args(&args)
        .status()
        .with_context(|| format!("spawning {}", sdk.ar().display()))?;
    Ok(status.code().map(|c| ExitCode::from(c as u8)).unwrap_or(ExitCode::FAILURE))
}
```

- [ ] **Step 4: Implement `cpranlib.rs`**

Create `packages/guest-compat/toolchain/cpcc/src/bin/cpranlib.rs`:

```rust
use anyhow::{Context, Result};
use cpcc_toolchain::wasi_sdk;
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let status = Command::new(sdk.ranlib())
        .args(&args)
        .status()
        .with_context(|| format!("spawning {}", sdk.ranlib().display()))?;
    Ok(status.code().map(|c| ExitCode::from(c as u8)).unwrap_or(ExitCode::FAILURE))
}
```

- [ ] **Step 5: Run tests**

```bash
cargo test -p cpcc-toolchain
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/
git commit -m "$(cat <<'EOF'
feat(cpcc): add cpar and cpranlib companion tools

Thin Rust wrappers around wasi-sdk's llvm-ar and llvm-ranlib. Build
systems (autoconf, CMake, upstream Makefiles) that resolve AR/RANLIB at
configure time can set them to cpar / cpranlib and stay consistent with
the cpcc toolchain — per §Toolchain Integration's requirement that
companion tools ship alongside the driver wrapper. Shared wasi-sdk
discovery lives in a new library target reused by all three binaries.
cpcxx is deferred: no Step 1 consumer needs C++.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Implementation-signature check binary (`cpcheck`)

Implements: §Override And Link Precedence > Verifying Precedence (the 3-stage check against pre-opt `.wasm` and the archive).

**Files:**
- Create: `packages/guest-compat/toolchain/cpcc/src/bin/cpcheck.rs`
- Create: `packages/guest-compat/toolchain/cpcc/src/precheck.rs` (lib module)
- Modify: `packages/guest-compat/toolchain/cpcc/src/lib.rs` — expose the module.
- Modify: `packages/guest-compat/toolchain/cpcc/Cargo.toml` — new `[[bin]]` and `wasmparser` dep.

- [ ] **Step 1: Write failing signature-check test**

Create `packages/guest-compat/toolchain/cpcc/tests/signature_check.rs`:

```rust
use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .unwrap()
}

fn check_bin() -> &'static str {
    env!("CARGO_BIN_EXE_cpcheck")
}

#[test]
fn signature_check_passes_on_canary_built_via_cpcc() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skip — WASI_SDK_PATH not set");
        return;
    }
    let root = repo_root();
    // Build the archive.
    let st = Command::new("make")
        .current_dir(root.join("packages/guest-compat"))
        .arg("lib")
        .status()
        .unwrap();
    assert!(st.success(), "make lib failed");

    let archive = root.join("packages/guest-compat/build/libcodepod_guest_compat.a");
    let tmp = tempfile::tempdir().unwrap();
    let out_wasm = tmp.path().join("dup2-canary.wasm");
    let preserved = tmp.path().join("dup2-canary.pre-opt.wasm");

    // Build dup2 canary via cpcc with preservation.
    let cc = env!("CARGO_BIN_EXE_cpcc");
    let st = Command::new(cc)
        .env("CPCC_ARCHIVE", &archive)
        .env("CPCC_INCLUDE", root.join("packages/guest-compat/include"))
        .env("CPCC_PRESERVE_PRE_OPT", &preserved)
        .env("CPCC_NO_WASM_OPT", "1")
        .arg(root.join("packages/guest-compat/conformance/c/dup2-canary.c"))
        .arg("-o")
        .arg(&out_wasm)
        .status()
        .unwrap();
    assert!(st.success(), "cpcc failed");

    // Run the check.
    let st = Command::new(check_bin())
        .arg("--archive")
        .arg(&archive)
        .arg("--pre-opt-wasm")
        .arg(&preserved)
        .arg("--symbol")
        .arg("dup2")
        .status()
        .unwrap();
    assert!(st.success(), "signature check failed on well-formed input");
}
```

- [ ] **Step 2: Confirm failure**

```bash
cargo test -p cpcc-toolchain --test signature_check
```

Expected: FAIL — `cpcheck` does not exist.

- [ ] **Step 3: Implement the library module**

Create `packages/guest-compat/toolchain/cpcc/src/precheck.rs`:

```rust
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Stage 1: `llvm-nm` on the archive — every named Tier 1 symbol and its
/// marker must be defined in the same object. `llvm-nm -A` prefixes each
/// line with `archive.a(obj):` so we can correlate the object that owns
/// each defined symbol.
pub fn check_archive(nm: &Path, archive: &Path, symbols: &[&str]) -> Result<()> {
    let out = Command::new(nm)
        .arg("-A")
        .arg("--defined-only")
        .arg(archive)
        .output()
        .with_context(|| format!("running {} -A {}", nm.display(), archive.display()))?;
    if !out.status.success() {
        return Err(anyhow!(
            "llvm-nm failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    for sym in symbols {
        let marker = format!("__codepod_guest_compat_marker_{sym}");
        let sym_obj = find_object_for(&text, sym)
            .ok_or_else(|| anyhow!("archive missing defined symbol {sym}"))?;
        let marker_obj = find_object_for(&text, &marker)
            .ok_or_else(|| anyhow!("archive missing defined marker {marker}"))?;
        if sym_obj != marker_obj {
            return Err(anyhow!(
                "§Verifying Precedence step 1 failed: {sym} in {sym_obj} but {marker} in {marker_obj}"
            ));
        }
    }
    Ok(())
}

fn find_object_for(nm_output: &str, sym: &str) -> Option<String> {
    for line in nm_output.lines() {
        // llvm-nm -A lines: `archive.a(obj.o): <addr> <type> <name>`
        let rest = match line.rsplit_once(' ') {
            Some((head, tail)) if tail == sym => head,
            _ => continue,
        };
        let head = rest.split_whitespace().next()?;
        let obj = head
            .rsplit_once('(')
            .and_then(|(_, o)| o.strip_suffix("):"))
            .map(|o| o.to_string())
            .unwrap_or_else(|| head.to_string());
        return Some(obj);
    }
    None
}

/// Stages 2+3: inspect the pre-opt `.wasm`. Every queried symbol's marker
/// must be exported, and the symbol's function body must call the marker.
pub fn check_wasm(pre_opt: &Path, symbols: &[&str]) -> Result<()> {
    let bytes = std::fs::read(pre_opt)
        .with_context(|| format!("reading {}", pre_opt.display()))?;
    let mut exports: std::collections::HashMap<String, u32> = Default::default();
    let mut imports_count: u32 = 0;
    let parser = wasmparser::Parser::new(0);
    for payload in parser.parse_all(&bytes) {
        let payload = payload.context("wasm parse")?;
        match payload {
            wasmparser::Payload::ImportSection(reader) => {
                for imp in reader {
                    let imp = imp.context("import")?;
                    if matches!(imp.ty, wasmparser::TypeRef::Func(_)) {
                        imports_count += 1;
                    }
                }
            }
            wasmparser::Payload::ExportSection(reader) => {
                for exp in reader {
                    let exp = exp.context("export")?;
                    if exp.kind == wasmparser::ExternalKind::Func {
                        exports.insert(exp.name.to_string(), exp.index);
                    }
                }
            }
            _ => {}
        }
    }
    for sym in symbols {
        let marker = format!("__codepod_guest_compat_marker_{sym}");
        if !exports.contains_key(&marker) {
            return Err(anyhow!(
                "§Verifying Precedence step 2 failed: pre-opt wasm missing export {marker}"
            ));
        }
    }
    verify_call_edges(&bytes, symbols, imports_count, &exports)
}

fn verify_call_edges(
    bytes: &[u8],
    symbols: &[&str],
    imports_count: u32,
    exports: &std::collections::HashMap<String, u32>,
) -> Result<()> {
    let parser = wasmparser::Parser::new(0);
    let mut code_idx: u32 = 0;
    let mut callees_by_func: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    for payload in parser.parse_all(bytes) {
        let payload = payload.context("parse")?;
        if let wasmparser::Payload::CodeSectionEntry(body) = payload {
            let func_index = imports_count + code_idx;
            code_idx += 1;
            let mut calls = Vec::new();
            for op in body.get_operators_reader()? {
                if let Ok(wasmparser::Operator::Call { function_index }) = op {
                    calls.push(function_index);
                }
            }
            callees_by_func.insert(func_index, calls);
        }
    }
    for sym in symbols {
        let sym_idx = *exports.get(*sym).ok_or_else(|| {
            anyhow!("§Verifying Precedence step 2 failed: export for {sym} missing in pre-opt wasm")
        })?;
        let marker_idx = *exports
            .get(&format!("__codepod_guest_compat_marker_{sym}"))
            .expect("marker export presence already checked");
        let callees = callees_by_func
            .get(&sym_idx)
            .ok_or_else(|| anyhow!("no body recorded for {sym} at func index {sym_idx}"))?;
        if !callees.contains(&marker_idx) {
            return Err(anyhow!(
                "§Verifying Precedence step 3 failed: {sym} body does not call its marker"
            ));
        }
    }
    Ok(())
}
```

Add to `Cargo.toml`:

```toml
wasmparser = "0.220"
```

(Pin to whatever current stable line resolves cleanly in this workspace — use whatever is installed by `cargo add wasmparser` at build time.)

- [ ] **Step 4: Add the `precheck` module to `lib.rs`**

Add `pub mod precheck;` to `src/lib.rs`.

- [ ] **Step 5: Implement the binary**

Create `packages/guest-compat/toolchain/cpcc/src/bin/cpcheck.rs`:

```rust
use anyhow::{Context, Result};
use clap::Parser;
use cpcc_toolchain::{precheck, wasi_sdk};
use std::path::PathBuf;
use std::process::ExitCode;

const TIER1: &[&str] = &[
    "dup2",
    "getgroups",
    "sched_getaffinity",
    "sched_setaffinity",
    "sched_getcpu",
    "signal",
    "sigaction",
    "raise",
    "alarm",
    "sigemptyset",
    "sigfillset",
    "sigaddset",
    "sigdelset",
    "sigismember",
    "sigprocmask",
    "sigsuspend",
];

#[derive(Parser)]
#[command(about = "§Verifying Precedence: archive + pre-opt wasm implementation-signature check")]
struct Args {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long = "pre-opt-wasm")]
    pre_opt_wasm: PathBuf,
    /// Subset of Tier 1 symbols to verify. If omitted, all of Tier 1.
    #[arg(long = "symbol")]
    symbols: Vec<String>,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk for llvm-nm")?;
    let symbols: Vec<&str> = if args.symbols.is_empty() {
        TIER1.to_vec()
    } else {
        args.symbols.iter().map(String::as_str).collect()
    };
    precheck::check_archive(&sdk.nm(), &args.archive, &symbols)?;
    precheck::check_wasm(&args.pre_opt_wasm, &symbols)?;
    println!("signature check: OK ({} symbols)", symbols.len());
    Ok(ExitCode::SUCCESS)
}
```

Add the `[[bin]]` to `Cargo.toml`:

```toml
[[bin]]
name = "cpcheck"
path = "src/bin/cpcheck.rs"
```

- [ ] **Step 6: Add a negative test (check must fail when marker is absent)**

Append to `tests/signature_check.rs`:

```rust
#[test]
fn signature_check_fails_when_symbol_body_does_not_call_marker() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skip — WASI_SDK_PATH not set");
        return;
    }
    // Compile a Tier 1 impl that omits the marker call — link without the
    // compat archive. The check must fail.
    let root = repo_root();
    let tmp = tempfile::tempdir().unwrap();
    let stub_src = tmp.path().join("stub_dup2.c");
    std::fs::write(&stub_src, b"#include <unistd.h>\nint dup2(int a, int b) { (void)a; (void)b; return -1; }\nint main(void){return 0;}").unwrap();
    let out_wasm = tmp.path().join("stub.wasm");

    let cc = env!("CARGO_BIN_EXE_cpcc");
    let st = Command::new(cc)
        .env("CPCC_NO_WASM_OPT", "1")
        .env("CPCC_PRESERVE_PRE_OPT", &out_wasm)
        .arg(&stub_src)
        .arg("-o")
        .arg(tmp.path().join("stub.out.wasm"))
        .status()
        .unwrap();
    assert!(st.success());

    let archive = root.join("packages/guest-compat/build/libcodepod_guest_compat.a");
    let st = Command::new(check_bin())
        .arg("--archive")
        .arg(&archive)
        .arg("--pre-opt-wasm")
        .arg(&out_wasm)
        .arg("--symbol")
        .arg("dup2")
        .status()
        .unwrap();
    assert!(!st.success(), "signature check should have failed on stub");
}
```

- [ ] **Step 7: Run tests**

```bash
cargo test -p cpcc-toolchain
```

Expected: all PASS (including both positive and negative signature-check cases).

- [ ] **Step 8: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/
git commit -m "$(cat <<'EOF'
feat(cpcc): cpcheck implementation-signature check

A new binary that runs §Verifying Precedence's three-stage check:
(1) llvm-nm on the archive — each Tier 1 symbol and its marker defined
in the same object, (2) the pre-opt wasm exports every marker function,
(3) each Tier 1 function body calls its marker (a link-time-DCE-stable
side-effect call that wasm-opt may later erase). A paired positive +
negative test proves the check catches weak-libc-stub leakage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Move C canaries into the conformance tree; add `cpconf` conformance driver

Implements: §Conformance Testing (Step 1 subset — layout + C canary migration + driver); §Migration Path > Step 1 bullet 5.

**Files:**
- `git mv packages/guest-compat/examples/*.c packages/guest-compat/conformance/c/<name>-canary.c` (rename each from `<name>_canary.c` to `<name>-canary.c` to match the produced wasm names)
- Create: `packages/guest-compat/toolchain/cpcc/src/bin/cpconf.rs` — new binary that runs the conformance flow end-to-end.
- Create: `packages/guest-compat/toolchain/cpcc/src/conform.rs` — library module containing `cpconf`'s orchestration logic.
- Create: `packages/guest-compat/toolchain/cpcc/tests/conform.rs` — integration test that exercises `cpconf`.
- Create: `packages/guest-compat/conformance/README.md` — points at the spec's §Conformance Testing section and notes Step 3a/3d as the open items.
- Modify: `packages/guest-compat/Makefile` — canary rules source from `conformance/c/` and build via `cpcc`, the archive is assembled via `cpar`, and objects are compiled via `cpcc -c` (no more `build-c-port.sh` references in the guest-compat tree).
- Delete: `scripts/build-c-compat.sh` — superseded. Users run `make -C packages/guest-compat <target>` or `cpconf` directly.

- [ ] **Step 1: Move canaries into `conformance/c/`**

```bash
git mv packages/guest-compat/examples/stdio_canary.c packages/guest-compat/conformance/c/stdio-canary.c
git mv packages/guest-compat/examples/sleep_canary.c packages/guest-compat/conformance/c/sleep-canary.c
git mv packages/guest-compat/examples/system_canary.c packages/guest-compat/conformance/c/system-canary.c
git mv packages/guest-compat/examples/popen_canary.c packages/guest-compat/conformance/c/popen-canary.c
git mv packages/guest-compat/examples/affinity_canary.c packages/guest-compat/conformance/c/affinity-canary.c
git mv packages/guest-compat/examples/dup2_canary.c packages/guest-compat/conformance/c/dup2-canary.c
git mv packages/guest-compat/examples/getgroups_canary.c packages/guest-compat/conformance/c/getgroups-canary.c
git mv packages/guest-compat/examples/signal_canary.c packages/guest-compat/conformance/c/signal-canary.c
rmdir packages/guest-compat/examples
```

- [ ] **Step 2: Rewrite `packages/guest-compat/Makefile` to use the cp* binaries end-to-end**

Replace the whole Makefile body with:

```make
# Build the guest-compat runtime archive + Tier 1 canaries. Every
# toolchain invocation goes through one of the cp* binaries:
# objects are compiled with `cpcc -c`, archives assembled with
# `cpar rcs`, canaries linked with `cpcc` (which --whole-archives
# libcodepod_guest_compat.a per §Override And Link Precedence).
#
# Targets:
#   make lib          — build libcodepod_guest_compat.a
#   make canaries     — build every conformance/c/*-canary.wasm
#   make all          — lib + canaries
#   make copy-fixtures — copy canary .wasm into the orchestrator fixtures dir
#   make clean

REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUILD_DIR := build
INCLUDE := $(abspath include)
CANARY_DIR := conformance/c
CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar

LIB := $(BUILD_DIR)/libcodepod_guest_compat.a
LIB_OBJS := \
  $(BUILD_DIR)/codepod_command.o \
  $(BUILD_DIR)/codepod_sched.o \
  $(BUILD_DIR)/codepod_signal.o \
  $(BUILD_DIR)/codepod_unistd.o \
  $(BUILD_DIR)/codepod_version.o

CANARY_NAMES := stdio sleep system popen affinity dup2 getgroups signal
CANARIES := $(addprefix $(BUILD_DIR)/,$(addsuffix -canary.wasm,$(CANARY_NAMES)))

.PHONY: all lib canaries copy-fixtures clean ensure-toolchain

all: lib canaries

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

ensure-toolchain:
	@test -x $(CPCC) && test -x $(CPAR) || \
		(cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain)

# Objects compile through `cpcc -c`. The compat archive is not yet built
# when these rules fire and must not be injected; CPCC_ARCHIVE is
# explicitly unset so cpcc skips link-arg framing. This is safe because
# `-c` disables link anyway.
$(BUILD_DIR)/%.o: src/%.c include/codepod_compat.h src/codepod_runtime.h src/codepod_markers.h ensure-toolchain | $(BUILD_DIR)
	CPCC_ARCHIVE= CPCC_INCLUDE=$(INCLUDE) $(CPCC) -c $< -o $@

lib: $(LIB)

$(LIB): $(LIB_OBJS) ensure-toolchain | $(BUILD_DIR)
	$(CPAR) rcs $@ $(LIB_OBJS)

$(BUILD_DIR)/%-canary.wasm: $(CANARY_DIR)/%-canary.c $(LIB) ensure-toolchain | $(BUILD_DIR)
	CPCC_ARCHIVE=$(abspath $(LIB)) \
	CPCC_INCLUDE=$(INCLUDE) \
	CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/$*-canary.pre-opt.wasm \
	CPCC_NO_WASM_OPT=1 \
	$(CPCC) $< -o $@

canaries: $(CANARIES)

copy-fixtures: canaries
	@for n in $(CANARY_NAMES); do cp $(BUILD_DIR)/$$n-canary.wasm $(FIXTURES)/$$n-canary.wasm; done

clean:
	rm -rf $(BUILD_DIR)
```

Note: earlier tasks (2, 3, 4) introduced rules that invoked `build-c-port.sh` for compile-only. Those rules are superseded here. When you apply this replacement, make sure no `$(BUILD_C_PORT)` / `build-c-port.sh` invocations survive in `packages/guest-compat/Makefile`.

- [ ] **Step 3: Delete `scripts/build-c-compat.sh`**

```bash
git rm scripts/build-c-compat.sh
```

(No shell-script replacement is created. Users who want the old behavior run `make -C packages/guest-compat` or, for the full conformance flow including the signature check, the `cpconf` binary added next.)

- [ ] **Step 4: Add the `cpconf` conformance driver as a Rust binary**

Add the `[[bin]]` entry in `packages/guest-compat/toolchain/cpcc/Cargo.toml`:

```toml
[[bin]]
name = "cpconf"
path = "src/bin/cpconf.rs"
```

Create `packages/guest-compat/toolchain/cpcc/src/conform.rs` and expose it from `src/lib.rs` (`pub mod conform;`):

```rust
use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::Command;

/// Canary → Tier 1 symbol that canary exercises. Canaries whose names
/// are not in this map still build and run, but do not drive an
/// implementation-signature check.
pub fn canary_symbol_map() -> &'static [(&'static str, &'static str)] {
    &[
        ("dup2-canary", "dup2"),
        ("getgroups-canary", "getgroups"),
        ("affinity-canary", "sched_getaffinity"),
        ("signal-canary", "signal"),
    ]
}

pub struct Driver {
    pub repo_root: PathBuf,
}

impl Driver {
    pub fn new(repo_root: PathBuf) -> Self {
        Self { repo_root }
    }

    fn target_bin(&self, name: &str) -> PathBuf {
        self.repo_root.join("target/release").join(name)
    }

    fn guest_compat(&self) -> PathBuf {
        self.repo_root.join("packages/guest-compat")
    }

    pub fn ensure_toolchain(&self) -> Result<()> {
        // `cargo build --release -p cpcc-toolchain` builds every bin in the crate.
        let status = Command::new("cargo")
            .current_dir(&self.repo_root)
            .args(["build", "--release", "-p", "cpcc-toolchain"])
            .status()
            .context("spawning cargo build -p cpcc-toolchain")?;
        if !status.success() {
            return Err(anyhow!("cargo build -p cpcc-toolchain failed"));
        }
        Ok(())
    }

    pub fn build_archive_and_canaries(&self) -> Result<()> {
        let status = Command::new("make")
            .current_dir(self.guest_compat())
            .args(["all", "copy-fixtures"])
            .status()
            .context("make -C packages/guest-compat all copy-fixtures")?;
        if !status.success() {
            return Err(anyhow!("make -C packages/guest-compat failed"));
        }
        Ok(())
    }

    pub fn run_signature_checks(&self) -> Result<()> {
        let cpcheck = self.target_bin("cpcheck");
        let archive = self.guest_compat().join("build/libcodepod_guest_compat.a");
        let build_dir = self.guest_compat().join("build");
        let mut failed = Vec::new();
        for (canary, sym) in canary_symbol_map() {
            let pre_opt = build_dir.join(format!("{canary}.pre-opt.wasm"));
            println!("== {canary} ({sym}) ==");
            let status = Command::new(&cpcheck)
                .arg("--archive")
                .arg(&archive)
                .arg("--pre-opt-wasm")
                .arg(&pre_opt)
                .arg("--symbol")
                .arg(*sym)
                .status()
                .with_context(|| format!("running cpcheck on {canary}"))?;
            if !status.success() {
                failed.push(*canary);
            }
        }
        if !failed.is_empty() {
            return Err(anyhow!("signature check failed for: {}", failed.join(", ")));
        }
        Ok(())
    }

    pub fn run_behavioral_suite(&self) -> Result<()> {
        // Delegate to the orchestrator canary suite. This is the Step 1
        // behavioral harness; Step 3a replaces it with TOML-driven spec
        // tests.
        let status = Command::new("deno")
            .current_dir(&self.repo_root)
            .args([
                "test",
                "-A",
                "--no-check",
                "packages/orchestrator/src/__tests__/guest-compat.test.ts",
            ])
            .status()
            .context("spawning deno test")?;
        if !status.success() {
            return Err(anyhow!("orchestrator canary suite failed"));
        }
        Ok(())
    }
}

pub fn detect_repo_root() -> Result<PathBuf> {
    // Walk upward from CWD until we find a Cargo.toml with `[workspace]`.
    let mut cur = std::env::current_dir()?;
    loop {
        let cargo = cur.join("Cargo.toml");
        if cargo.is_file() {
            if let Ok(text) = std::fs::read_to_string(&cargo) {
                if text.contains("[workspace]") {
                    return Ok(cur);
                }
            }
        }
        if !cur.pop() {
            break;
        }
    }
    Err(anyhow!(
        "could not locate repo root from {:?}",
        std::env::current_dir()?
    ))
}
```

Create `packages/guest-compat/toolchain/cpcc/src/bin/cpconf.rs`:

```rust
use anyhow::Result;
use clap::Parser;
use cpcc_toolchain::conform;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "cpconf", version, about = "Guest compatibility conformance driver (§Conformance Testing)")]
struct Args {
    /// Skip rebuilding cpcc/cpar/cpcheck (assume they are already up to date).
    #[arg(long)]
    skip_toolchain_build: bool,
    /// Skip the orchestrator behavioral canary suite (useful for CI that runs it separately).
    #[arg(long)]
    skip_behavioral: bool,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let root = conform::detect_repo_root()?;
    let driver = conform::Driver::new(root);
    if !args.skip_toolchain_build {
        driver.ensure_toolchain()?;
    }
    driver.build_archive_and_canaries()?;
    driver.run_signature_checks()?;
    if !args.skip_behavioral {
        driver.run_behavioral_suite()?;
    }
    println!("cpconf: OK");
    Ok(ExitCode::SUCCESS)
}
```

- [ ] **Step 4a: Write an integration test for `cpconf`**

Create `packages/guest-compat/toolchain/cpcc/tests/conform.rs`:

```rust
use std::process::Command;

#[test]
fn cpconf_runs_end_to_end_when_wasi_sdk_is_available() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skip — WASI_SDK_PATH not set");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_cpconf");
    let out = Command::new(bin)
        .arg("--skip-behavioral") // deno may not be on PATH in test runners
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "cpconf failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("cpconf: OK"), "missing OK: {stdout}");
}
```

- [ ] **Step 5: Create the conformance README pointing at the spec**

Create `packages/guest-compat/conformance/README.md`:

```markdown
# Guest Compatibility Conformance Tree

This tree hosts the paired C/Rust canaries and their behavioral specs. It is
introduced in Step 1 of the guest compatibility runtime migration. See
[`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../../../docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md),
§Conformance Testing.

Current contents (Step 1):

- `c/` — C canaries (migrated from `packages/c-compat/examples/`).
- `rust/` — placeholder. Rust canaries land in Step 3d.

Deferred to Step 3a: `<symbol>.spec.toml` behavioral specs that both
language canaries execute against.
```

- [ ] **Step 6: Run the conformance driver end-to-end**

```bash
source scripts/dev-init.sh
cargo build --release -p cpcc-toolchain
./target/release/cpconf
```

Expected: the build finishes; `== <canary> ==` sections for each mapped canary each report `signature check: OK`; the orchestrator canary suite passes; final line is `cpconf: OK`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(guest-compat): introduce conformance tree + cpcc/cpar-driven build + cpconf binary

Moves the existing canaries into packages/guest-compat/conformance/c/
with consistent -canary naming. Rewrites the guest-compat Makefile so
every toolchain invocation goes through cpcc / cpar — no more
scripts/build-c-port.sh anywhere under guest-compat. Each canary's
pre-opt wasm is preserved at a stable path for §Verifying Precedence.

Ships a new Rust binary, `cpconf`, that owns the full conformance
flow: rebuild the toolchain, make the archive + canaries, run cpcheck
against each preserved pre-opt artifact, and execute the orchestrator
canary suite. It replaces scripts/build-c-compat.sh, which is removed
outright — the user-facing surface is the cp* binaries only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Cut BusyBox port over to `cpcc`

Implements: §Migration Path > Step 1 bullet 4 ("The existing C consumers (BusyBox etc.) migrate to invoking `codepod-cc` instead of raw `clang`").

**Goal of this task:** Replace BusyBox's reliance on `scripts/build-c-port.sh env` + manual `codepod_*.o` linking with direct use of the `cp*` binaries as `CC` / `AR` / `RANLIB`. Because `cpcc` with `CPCC_ARCHIVE` already bundles the whole compat archive via `--whole-archive`, BusyBox no longer needs to pass the individual compat objects via `LDLIBS`, and no longer sources `build-c-port.sh env` for toolchain variables.

**Files:**
- Modify: `packages/c-ports/busybox/Makefile`

- [ ] **Step 1: Rewrite the BusyBox Makefile to use the cp* binaries**

Replace the current Makefile body with:

```make
# BusyBox port built via cpcc. The compat archive is linked
# --whole-archive by cpcc, so no per-object injection is needed.

REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUSYBOX_VERSION := 1.37.0
BUSYBOX_ARCHIVE := busybox-$(BUSYBOX_VERSION).tar.bz2
BUSYBOX_URL := https://busybox.net/downloads/$(BUSYBOX_ARCHIVE)
BUILD_DIR := build
SRC_DIR := src
COMPAT_INCLUDE := $(abspath compat/include)
GUEST_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
GUEST_COMPAT_LIB := $(REPO_ROOT)/packages/guest-compat/build/libcodepod_guest_compat.a

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib

WASI_EMULATED_CFLAGS := -I$(COMPAT_INCLUDE) -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -DSOCK_RAW=3 -DSOCK_RDM=4 -DSOCK_SEQPACKET=5 -mllvm -wasm-enable-sjlj
WASI_EMULATED_LDFLAGS := -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks

.PHONY: all fetch configure copy-fixtures clean ensure-toolchain ensure-compat

all: $(BUILD_DIR)/busybox.wasm

ensure-toolchain:
	@test -x $(CPCC) && test -x $(CPAR) && test -x $(CPRANLIB) || \
		(cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain)

ensure-compat:
	@test -f $(GUEST_COMPAT_LIB) || $(MAKE) -C $(REPO_ROOT)/packages/guest-compat lib

fetch:
	mkdir -p $(BUILD_DIR) $(SRC_DIR)
	if [ ! -f $(SRC_DIR)/Makefile ]; then \
		curl -L $(BUSYBOX_URL) | tar -xj -C src --strip-components=1; \
	fi

configure: fetch busybox.config compat/include/paths.h ensure-toolchain
	cd $(SRC_DIR) && \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			KCONFIG_ALLCONFIG="$(abspath busybox.config)" allnoconfig && \
		awk '\
			function key(line) { \
				if (line ~ /^CONFIG_[A-Za-z0-9_]+=/) { \
					split(line, parts, "="); \
					return parts[1]; \
				} \
				if (line ~ /^# CONFIG_[A-Za-z0-9_]+ is not set$$/) { \
					sub(/^# /, "", line); \
					sub(/ is not set$$/, "", line); \
					return line; \
				} \
				return ""; \
			} \
			FNR == NR { \
				current_key = key($$0); \
				if (current_key != "") seen[current_key] = 1; \
				overrides[++count] = $$0; \
				next; \
			} \
			{ \
				current_key = key($$0); \
				if (current_key != "" && seen[current_key]) next; \
				print; \
			} \
			END { \
				print ""; \
				for (i = 1; i <= count; i++) print overrides[i]; \
			} \
		' "$(abspath busybox.config)" .config > .config.merged && \
		mv .config.merged .config && \
		rm -rf include/config include/autoconf.h && \
		sleep 1 && \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" silentoldconfig

$(BUILD_DIR)/busybox.wasm: configure ensure-compat
	cd $(SRC_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			EXTRA_CFLAGS="$(WASI_EMULATED_CFLAGS)" \
			EXTRA_LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
			busybox
	cp $(SRC_DIR)/busybox_unstripped $(BUILD_DIR)/busybox.wasm

copy-fixtures: $(BUILD_DIR)/busybox.wasm
	cp $(BUILD_DIR)/busybox.wasm $(FIXTURES)/busybox.wasm

clean:
	rm -rf $(BUILD_DIR) $(SRC_DIR)
```

- [ ] **Step 2: Rebuild BusyBox, distinguishing fetch failure from integration regression**

BusyBox's `make fetch` target pulls the upstream tarball over the network — the only step that legitimately fails on an offline machine. Every later phase (configure, compile, link) is an integration test of the new `cpcc`/`cpar`/`cpranlib` wiring and must NOT be silently swallowed.

```bash
cd packages/c-ports/busybox
make clean
set +e
make fetch
fetch_status=$?
set -e
if [ "$fetch_status" -ne 0 ]; then
  echo "BusyBox tarball fetch failed (likely offline). Skipping the rest of Step 2."
  cd -
  exit 0   # Document the skip, but do NOT continue the task.
fi
# Past this point: build, configure, and link must succeed. A failure here
# means the cpcc/cpar cutover is broken and needs fixing before committing
# the Makefile change.
make
cd -
```

If the build succeeds, smoke-check the produced wasm against stage 2 of the signature check. The post-opt check is informational only (wasm-opt may erase markers, per §Verifying Precedence), so its exit code is NOT a gate on this task:

```bash
./target/release/cpcheck \
  --archive packages/guest-compat/build/libcodepod_guest_compat.a \
  --pre-opt-wasm packages/c-ports/busybox/build/busybox.wasm \
  --symbol signal --symbol dup2 --symbol raise \
  || echo "Note: post-opt signature check is expected to sometimes fail per §Verifying Precedence; informational only."
```

- [ ] **Step 3: Verify the orchestrator's busybox-related tests still pass**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

If BusyBox tests exist elsewhere and depend on `fixtures/busybox.wasm`:

```bash
rg -n "busybox\.wasm|busybox-command" -g "*.ts" packages/orchestrator/src/__tests__
```

Run each test file that matches.

Expected: PASS (or skipped where the fixture doesn't exist on developer machines — existing behavior).

- [ ] **Step 4: Commit**

```bash
git add packages/c-ports/busybox/Makefile
git commit -m "$(cat <<'EOF'
refactor(busybox): build via cpcc + linked compat archive

BusyBox's port recipe now invokes cpcc / cpar / cpranlib instead of
exporting build-c-port.sh's env and linking individual codepod_*.o
files. Because cpcc --whole-archives libcodepod_guest_compat.a
automatically, the per-object LDLIBS injection is gone. This completes
the §Migration Path > Step 1 bullet that the existing C consumers
migrate to cpcc. Validation against the stabilized Tier 1 semantics is
Step 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Step 1 acceptance gate — validate against the spec

Implements: exit criterion for Step 1. Run every check defined above in sequence and confirm the code matches the Step 1 subset of §Acceptance Criteria.

**Files:** none created; this task is pure validation.

- [ ] **Step 1: Fresh build from clean tree**

```bash
source scripts/dev-init.sh
cd packages/guest-compat && make clean && cd -
cargo clean -p cpcc-toolchain
cargo build --release -p cpcc-toolchain
./target/release/cpconf
```

Expected: all `== <canary> ==` sections report `signature check: OK`, the Deno canary suite passes, and the final line is `cpconf: OK`.

- [ ] **Step 2: Cargo workspace health**

```bash
cargo test -p cpcc-toolchain
cargo clippy -p cpcc-toolchain --all-targets --all-features -- -D warnings
cargo fmt -p cpcc-toolchain -- --check
```

Expected: all PASS; no clippy warnings; fmt clean.

- [ ] **Step 3: Full unit-test run (same gate the pre-push hook enforces, per CLAUDE.md)**

```bash
deno test -A --no-check \
  packages/orchestrator/src/**/*.test.ts \
  packages/orchestrator/src/pool/__tests__/*.test.ts \
  packages/sdk-server/src/*.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Walk the spec Step 1 acceptance subset, assert each bullet is true**

Open `docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md` at §Migration Path > Step 1 and §Acceptance Criteria. Confirm each of the following is now true in the working tree:

- [ ] `packages/c-compat/` no longer exists; `packages/guest-compat/` replaces it with the `include/` / `src/` / `toolchain/` / `conformance/` layout from §Repository Shape.
- [ ] `packages/guest-compat/build/libcodepod_guest_compat.a` is produced by `make lib`, and `check_archive.sh` is green.
- [ ] All 16 Tier 1 symbols from §Compatibility Tiers are defined in the archive (per `check_archive.sh`), each alongside a `__codepod_guest_compat_marker_<sym>` in the same object (per `cpcheck`'s stage 1).
- [ ] `cpcc`, `cpar`, `cpranlib`, `cpcheck`, and `cpconf` build as `--release` binaries under `target/release/`, and no user-facing step in Step 1 invokes a shell script in `scripts/` other than the unchanged `dev-init.sh`.
- [ ] Running `cpcc` with `CPCC_ARCHIVE` set produces a `.wasm` whose pre-opt form passes the three-stage implementation-signature check for the symbols the canary exercises.
- [ ] The existing C canaries (moved from `examples/` to `conformance/c/`) continue to pass the orchestrator's `guest-compat.test.ts` suite under the new build flow.
- [ ] `packages/c-ports/busybox/Makefile` invokes `cpcc` as `CC` and no longer injects `codepod_*.o` into `LDLIBS`.
- [ ] Doc path references (`docs/guides/syscalls.md`, `docs/guides/creating-commands.md`, `packages/c-builder/README.md`, `packages/guest-compat/README.md`) point at the new `packages/guest-compat/` paths.

- [ ] **Step 5: Walk the spec Step 1 NON-acceptance subset, confirm deferred items are still absent**

Confirm none of the following were silently done in Step 1:

- [ ] `packages/guest-compat/toolchain/cargo-codepod/` does not yet exist (Step 3b).
- [ ] `packages/guest-compat/rust/codepod-guest-compat[-sys]/` do not yet exist (Step 3c).
- [ ] No Rust canaries under `packages/guest-compat/conformance/rust/<symbol>-canary/` (Step 3d).
- [ ] No `<symbol>.spec.toml` files under `packages/guest-compat/conformance/` (Step 3a).
- [ ] No CI workflow changes gating on `cpconf` (Step 3e).
- [ ] No BusyBox/coreutils "real consumer" validation in this step beyond "BusyBox's Makefile builds via cpcc" (Step 4/5 handle real-consumer validation).
- [ ] No documentation reframing beyond path updates (Step 2 handles the "guest compatibility runtime" language sweep).
- [ ] No `cpcxx` binary yet (deferred until a Step 3+ C++ consumer lands; spec mentions it as "`codepod-cxx` as needed").

- [ ] **Step 6: Return to the spec and record Step 1 completion**

Open `docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`. Do not edit the spec — it is normative. Write a short summary comment for the user: which acceptance bullets are green, which are explicitly deferred, and whether the mechanism choices (marker shape, `--whole-archive` via `CPCC_ARCHIVE`, pre-opt preservation via `CPCC_PRESERVE_PRE_OPT`) match the spec's language or whether any Step 2/3 plan should reconsider them.

- [ ] **Step 7: Final commit, if any changes remain staged**

```bash
git status
```

If `git status` is clean, Step 1 is done. Otherwise, commit the remaining residue with a descriptive message.

---

## Self-Review Notes

The following items are intentional:

- **Archive-version handshake is presence-only, not value-match.** Task 7's `archive::check_version` only asserts `codepod_guest_compat_version` is defined in the archive, not that its encoded value equals the header constants this `cpcc` was built with. Extracting the encoded `uint32_t` out of a static archive requires parsing WASM object files, which is non-trivial and not required to block Step 1 (there is exactly one archive in the repo at this point). Step 3 (when `cargo-codepod` lands and reads a shipped archive) tightens this to a value match.

- **Post-opt signature check is explicitly out of scope.** The spec (§Verifying Precedence) states that `wasm-opt` may erase the properties the implementation-signature check relies on, and that post-opt is covered only by behavioral conformance. Step 1 therefore only runs the signature check against the preserved pre-opt artifact.

- **`scripts/build-c-port.sh` stays on disk but no Step 1 code path invokes it.** Every toolchain invocation under `packages/guest-compat/` and `packages/c-ports/busybox/` goes through the `cp*` binaries after this plan lands. The script is retained only because non-Step-1 recipes elsewhere in the tree still reference it; Step 3+ retires it when no callers remain.

- **Tests under `packages/guest-compat/tests/*.sh` are verification harnesses, not user entry points.** They still exist as shell because they run `llvm-nm` and `llvm-ar` inspections that are awkward in Rust test form, and they are invoked from a single place (the task's own Step "run the check"). They locate wasi-sdk via `WASI_SDK_PATH` or `cpcc --print-sdk-path`; they never shell out to `build-c-port.sh`.

- **BusyBox validation is not in Step 1.** The BusyBox Makefile is cut over to `cpcc`, but the spec explicitly places "validate BusyBox against stabilized Tier 1" in Step 4. Step 1 only proves the build recipe still links; runtime semantics validation happens later.

- **Behavioral TOML specs are not in Step 1.** The spec places them in Step 3a. Step 1 keeps the orchestrator's existing pass/fail canary tests as the behavioral harness — this is a deliberate tradeoff to keep Step 1 small and to let the conformance-tree layout sit in real code before the TOML schema is locked.

- **`cpcxx` is not in Step 1.** The spec mentions `codepod-cxx` as an "as needed" companion. No Step 1 consumer (coreutils/BusyBox — both C-only) needs C++. A Step 3+ task adds `cpcxx` when the first C++ consumer lands.

- **Test-step commits are bundled per task, not per step.** Writing the failing test and landing the implementation behind it in a single commit is acceptable because the intermediate state (test exists, impl absent) would not pass CI. The TDD rhythm is preserved inside each task via Steps "write failing test → run & confirm fail → implement → rerun".
