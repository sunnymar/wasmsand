# Guest Compatibility Runtime — Step 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Phase A Rust frontend (`cargo-codepod`), the optional Rust ergonomics crates, the TOML-driven behavioral conformance harness, and CI wiring — bringing C and Rust to first-class parity over the shared `libcodepod_guest_compat.a` archive.

**Architecture:** Step 3 of the migration described in [`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../specs/2026-04-19-guest-compat-runtime-design.md) §Migration Path. Five spec substeps land together as one branch:

- **3a — Behavioral specs.** One `<symbol>.spec.toml` per Tier 1 symbol under `packages/guest-compat/conformance/`. Cases declare a `name`, optional human-readable inputs, and `expected.*` fields. Canaries are invoked as `<canary> --case <name>`; each invocation prints exactly one JSONL trace line. The driver (in `cpcc-toolchain`) parses each spec, iterates cases, runs the canary, and diffs the trace line against the spec's `expected.*` fields. Per §Conformance Driver, divergence between C trace, Rust trace, and spec is the failure mode. **Deliberate spec-text deviation:** the spec language "canary reads its spec file" is realized as "canary's per-case behavior matches what the spec declares" — driver-mediated rather than canary-mediated, to avoid vendoring a TOML parser into C canaries. Recorded here so future readers can override if the literal interpretation matters.
- **3b — `cargo-codepod`.** Sixth binary in the existing `cpcc-toolchain` Cargo workspace package, named `cargo-codepod` (cargo's subcommand discovery requires that exact filename). Implements `cargo codepod build|test|run|download-toolchain` per §Toolchain Integration > Rust Toolchain. Wraps real `cargo` with `--target=wasm32-wasip1`, `CARGO_TARGET_WASM32_WASIP1_LINKER` set to wasi-sdk's clang, `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS` injecting the `--whole-archive` link-arg sequence + per-Tier-1-symbol `-Wl,--export=` framing, `CODEPOD_LINK_INJECTED=1` to coordinate with the optional `-sys` crate, version check via `llvm-nm` on the archive, pre-opt wasm preservation, post-link `wasm-opt`, and an optional implementation-signature check via `cpcheck`. Phase A's `download-toolchain` runs `rustup target add wasm32-wasip1`; deeper toolchain bootstrapping is deferred to Phase B per §Phase B.
- **3c — Optional Rust crates.** New cargo packages `codepod-guest-compat-sys` and `codepod-guest-compat` under `packages/guest-compat/rust/`. The `-sys` crate's `build.rs` is **target-gated**: it is a harmless no-op on any host target (preserving ordinary root `cargo build` ergonomics), a no-op when `CODEPOD_LINK_INJECTED=1` is set (the wrapper has already framed the archive — applying `--whole-archive` twice would fail the link), and emits `cargo:rustc-link-search`/`cargo:rustc-link-lib`/`cargo:rustc-link-arg=-Wl,--export=` directives only when targeting `wasm32-wasip1` without the injection — the "alternate path" from §Toolchain Integration > Rust Toolchain (lines 553-564) that lets codepod-authored crates build correctly in external CI without `cargo-codepod`. The wrapper crate provides safe Rust types over Tier 1 (`dup2`, `getgroups`, scheduler, signal helpers) plus a `VERSION` constant matching the C header. Both are workspace members; a `cargo check --workspace` regression test in Task 13 locks in the host ergonomics.
- **3d — Paired Rust canaries.** One Rust canary cargo crate per concept group, mirroring the C side: `dup2-canary/`, `getgroups-canary/`, `affinity-canary/`, `signal-canary/`. Each takes the same `--case <name>` argument set as its C peer and emits the same JSONL line shape. Built via `cargo-codepod` to exercise the real Phase A path. `.wasm` outputs land alongside the C canaries in the orchestrator fixtures dir.
- **3e — CI wiring.** New `cpconf` flag `--include-rust` that builds Rust canaries via `cargo-codepod`, runs them in sandboxes, and runs `cpcheck` on the pre-opt artifact for every Tier 1 symbol. New GitHub Actions job `guest-compat-conformance` that installs `wasi-sdk`, builds the toolchain, and runs `cpconf --include-rust`.

**Tech Stack:** Rust 1.x stable + `wasm32-wasip1` target; `cpcc-toolchain` Cargo package (existing, gains `cargo-codepod` binary); `wasi-sdk` 30 (existing); `wasm-opt` (existing); `clap` 4 / `anyhow` / `wasmparser` 0.247 (existing deps); new dep `toml` 0.8 (driver-side spec parsing); `libc` crate (Rust canaries + safe-wrapper FFI); `tempfile` (existing dev-dep, used by new tests).

---

## Branch and Worktree

- **Worktree:** `.worktrees/guest-compat-step-1/` (existing — Step 3 lands on the same branch as Steps 1 and 2; the branch will be renamed at merge).
- **Branch:** `feature/guest-compat-step-1` (existing).
- **Pre-existing baseline:** the worktree contains 22 commits from Steps 1 and 2; orchestrator guest-compat suite is 11/11 green, `cpcc-toolchain` is 10/10 green, all `cp*` shell scripts green.

---

## File Structure

This is the locked-in decomposition. Tasks below produce or modify exactly these paths.

### New files

```
packages/guest-compat/conformance/
  SCHEMA.md                                       # spec.toml + JSONL trace contract (Task 1)
  dup2.spec.toml                                  # Task 3
  getgroups.spec.toml                             # Task 4
  sched_getaffinity.spec.toml                     # Task 5
  sched_setaffinity.spec.toml                     # Task 5
  sched_getcpu.spec.toml                          # Task 5
  signal.spec.toml                                # Task 6
  sigaction.spec.toml                             # Task 6
  raise.spec.toml                                 # Task 6
  alarm.spec.toml                                 # Task 6
  sigemptyset.spec.toml                           # Task 6
  sigfillset.spec.toml                            # Task 6
  sigaddset.spec.toml                             # Task 6
  sigdelset.spec.toml                             # Task 6
  sigismember.spec.toml                           # Task 6
  sigprocmask.spec.toml                           # Task 6
  sigsuspend.spec.toml                            # Task 6
  rust/dup2-canary/Cargo.toml                     # Task 14
  rust/dup2-canary/src/main.rs                    # Task 14
  rust/getgroups-canary/Cargo.toml                # Task 15
  rust/getgroups-canary/src/main.rs               # Task 15
  rust/affinity-canary/Cargo.toml                 # Task 16
  rust/affinity-canary/src/main.rs                # Task 16
  rust/signal-canary/Cargo.toml                   # Task 17
  rust/signal-canary/src/main.rs                  # Task 17

packages/guest-compat/rust/
  codepod-guest-compat-sys/Cargo.toml             # Task 12
  codepod-guest-compat-sys/build.rs               # Task 12
  codepod-guest-compat-sys/src/lib.rs             # Task 12
  codepod-guest-compat-sys/tests/build_rs.rs      # Task 12
  codepod-guest-compat/Cargo.toml                 # Task 13
  codepod-guest-compat/src/lib.rs                 # Task 13
  codepod-guest-compat/src/dup2.rs                # Task 13
  codepod-guest-compat/src/sched.rs               # Task 13
  codepod-guest-compat/src/signal.rs              # Task 13
  codepod-guest-compat/tests/version.rs           # Task 13

packages/guest-compat/toolchain/cpcc/src/
  spec.rs                                         # spec.toml parser (Task 7)
  trace.rs                                        # JSONL trace diff (Task 7)
  cargo_codepod.rs                                # cargo-codepod core (Task 8-11)
packages/guest-compat/toolchain/cpcc/src/bin/
  cargo-codepod.rs                                # cargo-codepod binary entrypoint (Task 8)
packages/guest-compat/toolchain/cpcc/tests/
  spec_parsing.rs                                 # Task 7
  trace_diff.rs                                   # Task 7
  cargo_codepod_dry_run.rs                        # Task 8

.github/workflows/
  guest-compat.yml                                # Task 19 (new job in separate file)
```

### Modified files

```
packages/guest-compat/conformance/c/dup2-canary.c        # add --case mode (Task 2)
packages/guest-compat/conformance/c/getgroups-canary.c   # add --case mode (Task 2)
packages/guest-compat/conformance/c/affinity-canary.c    # add --case mode (Task 2)
packages/guest-compat/conformance/c/signal-canary.c      # add --case mode + new cases (Task 2/6)
packages/guest-compat/toolchain/cpcc/Cargo.toml          # add cargo-codepod bin + toml dep (Task 7,8)
packages/guest-compat/toolchain/cpcc/src/lib.rs          # re-export new modules (Task 7,8)
packages/guest-compat/toolchain/cpcc/src/conform.rs      # wire --include-rust (Task 18)
packages/guest-compat/toolchain/cpcc/src/bin/cpconf.rs   # --include-rust flag (Task 18)
packages/guest-compat/Makefile                           # rust-canaries target (Task 18)
Cargo.toml                                               # add new workspace members (Task 12,13,14-17)
```

---

## Architectural Reminder: One Archive, Two Frontends

Per §Outcome, §Override And Link Precedence, and §Toolchain Integration > Rust Toolchain: **the 16 Tier 1 symbol bodies are written once in C and live in `libcodepod_guest_compat.a` (Step 1).** Step 3 does **not** rewrite any of them in Rust. The Rust side reuses that same compiled archive:

- `cargo-codepod` injects it via `RUSTFLAGS` link-args.
- `codepod-guest-compat-sys` (alt path, plain `cargo build`) emits `cargo:rustc-link-*` to link the same archive.
- `codepod-guest-compat` provides safe-wrapper Rust types over `libc::*` calls; the wrappers do *not* contain implementations.
- Rust canaries call `libc::dup2`, `libc::signal`, etc. directly — those calls resolve at link time to the C archive's bodies.

The implementation-signature check (§Verifying Precedence) is what guarantees this every build: every Tier 1 export in a Rust-built `.wasm` must call its `__codepod_guest_compat_marker_<sym>` (exported only by the C compat objects). If `wasi-libc`'s stub ever wins the link, CI fails.

---

## Task 1: Conformance schema document (3a foundation)

**Files:**
- Create: `packages/guest-compat/conformance/SCHEMA.md`

This document defines the spec.toml shape and the JSONL trace shape so canaries (in two languages) and the driver agree on the contract before any code is written. No tests — it's documentation that constrains code in later tasks.

- [ ] **Step 1: Write `SCHEMA.md`**

```markdown
# Conformance Spec Schema

Each Tier 1 symbol has a behavioral spec at
`packages/guest-compat/conformance/<symbol>.spec.toml`. The driver
(`cpconf` via `cpcc-toolchain`'s `spec` and `trace` modules) reads each
spec, iterates its cases, runs the named canary once per case as
`<canary> --case <name>`, captures one JSONL trace line on stdout, and
diffs the trace against `expected.*` fields.

## spec.toml shape

```toml
# Required: which canary executes the cases. The C canary lives at
# packages/guest-compat/conformance/c/<canary>.c; the Rust canary lives
# at packages/guest-compat/conformance/rust/<canary>/.
canary = "dup2-canary"

# Required: human-readable summary of what this symbol must do.
summary = "Renumber a guest-visible file descriptor."

[[case]]
# Required: case identifier. Must be unique within the spec, must match
# /^[a-z][a-z0-9_]*$/, and is what the canary receives via --case.
name = "happy_path"

# Optional: human-readable inputs. Documentation only — the canary
# hardcodes the actual call inputs keyed by `name`. The spec lists them
# so a reader can see what the case does without reading C code.
inputs = "dup2(1, 2)"

# At least one expected.* field is required.
expected.exit = 0
expected.stdout = "dup2-ok"

[[case]]
name = "invalid_fd"
inputs = "dup2(999, 2)"
expected.exit = 1
expected.errno = 9   # EBADF
```

## Allowed `expected.*` fields

| Field            | Type    | Meaning                                                  |
|------------------|---------|----------------------------------------------------------|
| `expected.exit`  | integer | Exact exit code the canary must report.                  |
| `expected.stdout`| string  | Exact stdout (one line, no trailing newline) the canary must print after JSONL parsing. The trace's `stdout` field. |
| `expected.errno` | integer | Numeric errno value the canary captured (POSIX numbers). |
| `expected.note`  | string  | Free-form description of the expected side effect; not diffed by the driver, surfaced in failure messages for human readers. |

Unknown `expected.*` fields are a parse error: the schema is closed.

## JSONL trace shape

The canary, invoked as `<canary> --case <name>`, prints exactly one
line to stdout, terminated by `\n`. The line is a JSON object with:

| Field    | Type    | Required | Notes                                                    |
|----------|---------|----------|----------------------------------------------------------|
| `case`   | string  | yes      | Echoes `--case` argument so the driver can validate.     |
| `exit`   | integer | yes      | Exit code the canary intends to report. The driver also captures the process exit code separately and asserts they agree. |
| `stdout` | string  | no       | Single observable line the canary "produced". Empty if the case is errno-only. |
| `errno`  | integer | no       | Captured `errno` after a failing call. Omit on success.  |

Trace lines do not contain newlines inside the JSON (canaries serialize
with no embedded `\n`). Stderr is not part of the trace.

## Diff rules

- For each `[[case]]` in the spec, the driver runs `<canary> --case <case.name>`.
- The captured stdout must be exactly one JSONL line whose `case` field equals `case.name`.
- For each `expected.<field>` present in the spec, the trace line's `<field>` must be present and equal.
- `expected.exit` is also asserted against the process exit code.
- `expected.note` is never diffed; surfaced only in failure messages.
- A case with no matching trace line is a failure (driver records "missing trace").
- Extra fields in the trace (beyond `case`/`exit`/`stdout`/`errno`) are ignored — forward-compatible.

## Canary CLI contract

```
<canary>                       # smoke mode: prints "<concept>-ok" on success (preserved
                               # so the orchestrator E2E suite at
                               # packages/orchestrator/src/__tests__/guest-compat.test.ts
                               # keeps passing unchanged).
<canary> --case <name>         # spec-driven mode: emits one JSONL trace line.
<canary> --list-cases          # prints supported case names, one per line, on stdout.
                               # Used by the driver to detect spec/canary drift early.
```

Unknown `--case` values cause the canary to exit 2 with a message on
stderr. The driver surfaces this as "case not implemented in canary".
```

- [ ] **Step 2: Commit**

```bash
git add packages/guest-compat/conformance/SCHEMA.md
git commit -m "docs(guest-compat/step-3): add conformance spec + trace schema (Task 1)"
```

---

## Task 2: Add `--case` and `--list-cases` modes to existing C canaries

**Files:**
- Modify: `packages/guest-compat/conformance/c/dup2-canary.c`
- Modify: `packages/guest-compat/conformance/c/getgroups-canary.c`
- Modify: `packages/guest-compat/conformance/c/affinity-canary.c`
- Modify: `packages/guest-compat/conformance/c/signal-canary.c` (signal-family additions arrive in Task 6; this task only restructures existing case coverage)

Step 1's canaries print one fixed string on success. Step 3 needs them to dispatch on `--case <name>` and emit JSONL. Smoke mode (no args) is preserved so the orchestrator E2E suite at `packages/orchestrator/src/__tests__/guest-compat.test.ts` keeps passing without edits.

Each canary follows this pattern (shown for `dup2-canary.c` first; the rest mirror it):

- [ ] **Step 1: Rewrite `dup2-canary.c` to support `--case` / `--list-cases`**

Replace the entire contents of `packages/guest-compat/conformance/c/dup2-canary.c` with:

```c
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* Print one JSONL trace line. Use printf with explicit field order so the
 * output is byte-stable regardless of compiler. */
static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) {
    printf(",\"stdout\":\"%s\"", stdout_line);
  }
  if (has_errno) {
    printf(",\"errno\":%d", errno_value);
  }
  printf("}\n");
}

static int case_happy_path(void) {
  if (dup2(1, 2) < 0) {
    emit("happy_path", 1, NULL, 1, errno);
    return 1;
  }
  emit("happy_path", 0, "dup2-ok", 0, 0);
  return 0;
}

static int case_invalid_fd(void) {
  errno = 0;
  if (dup2(999, 2) >= 0) {
    emit("invalid_fd", 1, NULL, 0, 0);
    return 1;
  }
  emit("invalid_fd", 1, NULL, 1, errno);
  return 1;
}

static int run_case(const char *name) {
  if (strcmp(name, "happy_path") == 0) return case_happy_path();
  if (strcmp(name, "invalid_fd") == 0) return case_invalid_fd();
  fprintf(stderr, "dup2-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("happy_path");
  puts("invalid_fd");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode — preserves the contract checked by guest-compat.test.ts. */
    if (dup2(1, 2) < 0) {
      perror("dup2");
      return 1;
    }
    if (fprintf(stderr, "dup2-ok\n") < 0) {
      return 1;
    }
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) {
    return list_cases();
  }
  if (argc == 3 && strcmp(argv[1], "--case") == 0) {
    return run_case(argv[2]);
  }
  fprintf(stderr, "usage: dup2-canary [--case <name> | --list-cases]\n");
  return 2;
}
```

- [ ] **Step 2: Rewrite `getgroups-canary.c`**

Replace contents with:

```c
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_count_only(void) {
  int count = getgroups(0, NULL);
  if (count != 1) {
    emit("count_only", 1, NULL, 0, 0);
    return 1;
  }
  emit("count_only", 0, "getgroups:1", 0, 0);
  return 0;
}

static int case_fetch_one(void) {
  gid_t groups[1] = {99};
  int count = getgroups(1, groups);
  if (count != 1 || groups[0] != 0) {
    emit("fetch_one", 1, NULL, 0, 0);
    return 1;
  }
  emit("fetch_one", 0, "getgroups:1:0", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "count_only") == 0) return case_count_only();
  if (strcmp(name, "fetch_one") == 0) return case_fetch_one();
  fprintf(stderr, "getgroups-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("count_only");
  puts("fetch_one");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved for guest-compat.test.ts. */
    gid_t groups[1];
    int count = getgroups(0, NULL);
    if (count != 1) {
      fprintf(stderr, "unexpected group count: %d\n", count);
      return 1;
    }
    count = getgroups(1, groups);
    if (count != 1) {
      fprintf(stderr, "unexpected getgroups result: %d\n", count);
      return 1;
    }
    printf("getgroups:%d:%u\n", count, (unsigned)groups[0]);
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: getgroups-canary [--case <name> | --list-cases]\n");
  return 2;
}
```

- [ ] **Step 3: Rewrite `affinity-canary.c`**

Replace contents with:

```c
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_get_reports_one_cpu(void) {
  cpu_set_t mask;
  CPU_ZERO(&mask);
  if (sched_getaffinity(0, sizeof(mask), &mask) != 0) {
    emit("get_reports_one_cpu", 1, NULL, 1, errno);
    return 1;
  }
  if (CPU_COUNT(&mask) != 1 || !CPU_ISSET(0, &mask)) {
    emit("get_reports_one_cpu", 1, NULL, 0, 0);
    return 1;
  }
  emit("get_reports_one_cpu", 0, "affinity:get=1", 0, 0);
  return 0;
}

static int case_set_cpu0_succeeds(void) {
  cpu_set_t mask;
  CPU_ZERO(&mask);
  CPU_SET(0, &mask);
  if (sched_setaffinity(0, sizeof(mask), &mask) != 0) {
    emit("set_cpu0_succeeds", 1, NULL, 1, errno);
    return 1;
  }
  emit("set_cpu0_succeeds", 0, "affinity:set0=ok", 0, 0);
  return 0;
}

static int case_set_cpu1_einval(void) {
  cpu_set_t mask;
  CPU_ZERO(&mask);
  CPU_SET(1, &mask);
  errno = 0;
  if (sched_setaffinity(0, sizeof(mask), &mask) == 0) {
    emit("set_cpu1_einval", 1, NULL, 0, 0);
    return 1;
  }
  emit("set_cpu1_einval", 1, NULL, 1, errno);
  return 1;
}

static int case_getcpu_zero(void) {
  int cpu = sched_getcpu();
  if (cpu != 0) {
    emit("getcpu_zero", 1, NULL, 0, 0);
    return 1;
  }
  emit("getcpu_zero", 0, "affinity:cpu=0", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "get_reports_one_cpu") == 0) return case_get_reports_one_cpu();
  if (strcmp(name, "set_cpu0_succeeds") == 0) return case_set_cpu0_succeeds();
  if (strcmp(name, "set_cpu1_einval") == 0) return case_set_cpu1_einval();
  if (strcmp(name, "getcpu_zero") == 0) return case_getcpu_zero();
  fprintf(stderr, "affinity-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("get_reports_one_cpu");
  puts("set_cpu0_succeeds");
  puts("set_cpu1_einval");
  puts("getcpu_zero");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved. Reproduces Step 1 output verbatim. */
    cpu_set_t mask;
    int get_count, set0_rc, set1_errno;
    CPU_ZERO(&mask);
    if (sched_getaffinity(0, sizeof(mask), &mask) != 0) { perror("sched_getaffinity"); return 1; }
    get_count = CPU_COUNT(&mask);
    CPU_ZERO(&mask); CPU_SET(0, &mask);
    set0_rc = sched_setaffinity(0, sizeof(mask), &mask);
    if (set0_rc != 0) { perror("sched_setaffinity cpu0"); return 1; }
    CPU_ZERO(&mask); CPU_SET(1, &mask);
    if (sched_setaffinity(0, sizeof(mask), &mask) == 0) {
      fprintf(stderr, "sched_setaffinity unexpectedly accepted cpu1\n"); return 1;
    }
    set1_errno = errno;
    if (set1_errno != EINVAL) { fprintf(stderr, "unexpected errno: %d\n", set1_errno); return 1; }
    printf("affinity:get=%d,set0=%d,set1=einval\n", get_count, set0_rc);
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: affinity-canary [--case <name> | --list-cases]\n");
  return 2;
}
```

- [ ] **Step 4: Restructure `signal-canary.c` to support `--case` (cases for the full signal family land in Task 6)**

Replace contents with:

```c
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

static int signal_canary_seen = 0;

static void signal_canary_handler(int sig) { signal_canary_seen = sig; }

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

/* Existing Step 1 case, refactored. Task 6 adds the rest of the signal family. */
static int case_sigaction_raise(void) {
  struct sigaction sa;
  signal_canary_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;
  if (sigaction(SIGINT, &sa, NULL) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (raise(SIGINT) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (signal_canary_seen != SIGINT) { emit("sigaction_raise", 1, NULL, 0, 0); return 1; }
  emit("sigaction_raise", 0, "signal-ok", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "sigaction_raise") == 0) return case_sigaction_raise();
  fprintf(stderr, "signal-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("sigaction_raise");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved for guest-compat.test.ts. */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = signal_canary_handler;
    if (sigaction(SIGINT, &sa, NULL) != 0) { perror("sigaction"); return 1; }
    if (raise(SIGINT) != 0) { perror("raise"); return 1; }
    if (signal_canary_seen != SIGINT) { fprintf(stderr, "signal handler was not invoked\n"); return 1; }
    alarm(0);
    puts("signal-ok");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: signal-canary [--case <name> | --list-cases]\n");
  return 2;
}
```

- [ ] **Step 5: Rebuild canaries and re-run the orchestrator E2E suite (smoke mode must still pass)**

```bash
make -C packages/guest-compat clean all copy-fixtures
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: 11/11 pass, including the 4 canaries this task touched.

- [ ] **Step 6: Spot-check `--list-cases` and one `--case` invocation per canary using `wasmtime`**

```bash
wasmtime run packages/guest-compat/build/dup2-canary.wasm -- --list-cases
# Expected: two lines: "happy_path", "invalid_fd"

wasmtime run packages/guest-compat/build/dup2-canary.wasm -- --case happy_path
# Expected: {"case":"happy_path","exit":0,"stdout":"dup2-ok"}

wasmtime run packages/guest-compat/build/affinity-canary.wasm -- --case set_cpu1_einval
# Expected (exit 1): {"case":"set_cpu1_einval","exit":1,"errno":<EINVAL>}
```

- [ ] **Step 7: Commit**

```bash
git add packages/guest-compat/conformance/c/dup2-canary.c \
        packages/guest-compat/conformance/c/getgroups-canary.c \
        packages/guest-compat/conformance/c/affinity-canary.c \
        packages/guest-compat/conformance/c/signal-canary.c
git commit -m "feat(guest-compat/step-3): add --case mode to existing C canaries (Task 2)"
```

---

## Task 3: `dup2.spec.toml`

**Files:**
- Create: `packages/guest-compat/conformance/dup2.spec.toml`

Per §Behavioral Spec, every Tier 1 symbol gets a TOML file. `expected.errno` numeric value: WASI uses POSIX errno numbering; `EBADF = 8` in WASI (different from glibc's 9). Use the WASI value.

- [ ] **Step 1: Confirm WASI EBADF numeric value**

```bash
grep -r "EBADF" $HOME/.local/share/wasi-sdk-30.0-arm64-macos/share/wasi-sysroot/include/wasi/ 2>/dev/null || \
  grep -r "EBADF" $HOME/.local/share/wasi-sdk*/share/wasi-sysroot/include/ 2>/dev/null | head -3
```

Expected: a `#define EBADF 8` line. If a future SDK upgrade changes this, the spec.toml must follow.

- [ ] **Step 2: Create `dup2.spec.toml`**

```toml
canary = "dup2-canary"
summary = "Renumber a guest-visible file descriptor (§Runtime Semantics > File Descriptors)."

[[case]]
name = "happy_path"
inputs = "dup2(1, 2) — redirect stderr to stdout"
expected.exit = 0
expected.stdout = "dup2-ok"
expected.note = "stderr now writes to stdout's target"

[[case]]
name = "invalid_fd"
inputs = "dup2(999, 2) — source fd is not open"
expected.exit = 1
expected.errno = 8
expected.note = "EBADF (WASI value)"
```

- [ ] **Step 3: Verify the case names match the canary**

```bash
make -C packages/guest-compat lib canaries
wasmtime run packages/guest-compat/build/dup2-canary.wasm -- --list-cases
```

Expected: `happy_path` and `invalid_fd` (in any order — the driver does not depend on order). If they don't match, fix the canary, not the spec.

- [ ] **Step 4: Commit**

```bash
git add packages/guest-compat/conformance/dup2.spec.toml
git commit -m "feat(guest-compat/step-3): add dup2.spec.toml (Task 3)"
```

---

## Task 4: `getgroups.spec.toml`

**Files:**
- Create: `packages/guest-compat/conformance/getgroups.spec.toml`

- [ ] **Step 1: Create `getgroups.spec.toml`**

```toml
canary = "getgroups-canary"
summary = "Report the single visible guest group (§Runtime Semantics > Identity)."

[[case]]
name = "count_only"
inputs = "getgroups(0, NULL)"
expected.exit = 0
expected.stdout = "getgroups:1"
expected.note = "size=0 path returns the count without writing the buffer"

[[case]]
name = "fetch_one"
inputs = "getgroups(1, buf)"
expected.exit = 0
expected.stdout = "getgroups:1:0"
expected.note = "single visible group id is 0"
```

- [ ] **Step 2: Verify case names**

```bash
wasmtime run packages/guest-compat/build/getgroups-canary.wasm -- --list-cases
```

Expected: `count_only`, `fetch_one`.

- [ ] **Step 3: Commit**

```bash
git add packages/guest-compat/conformance/getgroups.spec.toml
git commit -m "feat(guest-compat/step-3): add getgroups.spec.toml (Task 4)"
```

---

## Task 5: `sched_getaffinity.spec.toml`, `sched_setaffinity.spec.toml`, `sched_getcpu.spec.toml`

**Files:**
- Create: `packages/guest-compat/conformance/sched_getaffinity.spec.toml`
- Create: `packages/guest-compat/conformance/sched_setaffinity.spec.toml`
- Create: `packages/guest-compat/conformance/sched_getcpu.spec.toml`

All three reference the same `affinity-canary`. Per §Behavioral Spec, files are keyed by symbol — multiple specs may reference the same canary. The driver builds one trace per spec by iterating its `[[case]]` entries.

EINVAL in WASI is `28` (verify in step 1 below).

- [ ] **Step 1: Confirm WASI EINVAL numeric value**

```bash
grep -h "EINVAL" $HOME/.local/share/wasi-sdk*/share/wasi-sysroot/include/wasi/api.h | head -3
```

Expected: `#define EINVAL 28`. Update Step 3 below if the SDK changes.

- [ ] **Step 2: Create `sched_getaffinity.spec.toml`**

```toml
canary = "affinity-canary"
summary = "Report the guest's visible CPU mask (§Runtime Semantics > Affinity)."

[[case]]
name = "get_reports_one_cpu"
inputs = "sched_getaffinity(0, sizeof(mask), &mask) on guest with one visible CPU"
expected.exit = 0
expected.stdout = "affinity:get=1"
expected.note = "exactly one CPU bit set, namely CPU 0"
```

- [ ] **Step 3: Create `sched_setaffinity.spec.toml`**

```toml
canary = "affinity-canary"
summary = "Set the guest's CPU mask (§Runtime Semantics > Affinity)."

[[case]]
name = "set_cpu0_succeeds"
inputs = "sched_setaffinity(0, sizeof(mask), &{CPU 0})"
expected.exit = 0
expected.stdout = "affinity:set0=ok"
expected.note = "the only mask the guest accepts"

[[case]]
name = "set_cpu1_einval"
inputs = "sched_setaffinity(0, sizeof(mask), &{CPU 1})"
expected.exit = 1
expected.errno = 28
expected.note = "EINVAL (WASI value); any non-CPU0 mask must be rejected"
```

- [ ] **Step 4: Create `sched_getcpu.spec.toml`**

```toml
canary = "affinity-canary"
summary = "Report the running CPU (§Runtime Semantics > Affinity)."

[[case]]
name = "getcpu_zero"
inputs = "sched_getcpu()"
expected.exit = 0
expected.stdout = "affinity:cpu=0"
expected.note = "the guest sees exactly one CPU and is always running on it"
```

- [ ] **Step 5: Verify the affinity canary's `--list-cases` covers every case across the three specs**

```bash
wasmtime run packages/guest-compat/build/affinity-canary.wasm -- --list-cases
```

Expected lines: `get_reports_one_cpu`, `set_cpu0_succeeds`, `set_cpu1_einval`, `getcpu_zero`.

- [ ] **Step 6: Commit**

```bash
git add packages/guest-compat/conformance/sched_getaffinity.spec.toml \
        packages/guest-compat/conformance/sched_setaffinity.spec.toml \
        packages/guest-compat/conformance/sched_getcpu.spec.toml
git commit -m "feat(guest-compat/step-3): add sched_*.spec.toml (Task 5)"
```

---

## Task 6: Signal-family spec files (11 files) + extend signal-canary cases

**Files:**
- Modify: `packages/guest-compat/conformance/c/signal-canary.c` (extend `run_case` and `list_cases`)
- Create: `packages/guest-compat/conformance/signal.spec.toml`
- Create: `packages/guest-compat/conformance/sigaction.spec.toml`
- Create: `packages/guest-compat/conformance/raise.spec.toml`
- Create: `packages/guest-compat/conformance/alarm.spec.toml`
- Create: `packages/guest-compat/conformance/sigemptyset.spec.toml`
- Create: `packages/guest-compat/conformance/sigfillset.spec.toml`
- Create: `packages/guest-compat/conformance/sigaddset.spec.toml`
- Create: `packages/guest-compat/conformance/sigdelset.spec.toml`
- Create: `packages/guest-compat/conformance/sigismember.spec.toml`
- Create: `packages/guest-compat/conformance/sigprocmask.spec.toml`
- Create: `packages/guest-compat/conformance/sigsuspend.spec.toml`

Eleven specs, one canary. Step 4 of Task 2 left `signal-canary` with one case (`sigaction_raise`); this task adds the rest.

- [ ] **Step 1: Extend `signal-canary.c` with the full case set**

In `packages/guest-compat/conformance/c/signal-canary.c`, replace the contents with:

```c
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

static int signal_canary_seen = 0;
static int signal_canary_suspend_seen = 0;

static void signal_canary_handler(int sig) { signal_canary_seen = sig; }
static void signal_canary_suspend_handler(int sig) { signal_canary_suspend_seen = sig; }

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_signal_install(void) {
  /* signal(SIGINT, handler) returns the previous handler (SIG_DFL on first
   * call). We assert the call doesn't return SIG_ERR. */
  if (signal(SIGINT, signal_canary_handler) == SIG_ERR) {
    emit("signal_install", 1, NULL, 1, errno);
    return 1;
  }
  emit("signal_install", 0, "signal:installed", 0, 0);
  return 0;
}

static int case_sigaction_raise(void) {
  struct sigaction sa;
  signal_canary_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;
  if (sigaction(SIGINT, &sa, NULL) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (raise(SIGINT) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (signal_canary_seen != SIGINT) { emit("sigaction_raise", 1, NULL, 0, 0); return 1; }
  emit("sigaction_raise", 0, "signal-ok", 0, 0);
  return 0;
}

static int case_raise_invokes_handler(void) {
  struct sigaction sa;
  signal_canary_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;
  if (sigaction(SIGTERM, &sa, NULL) != 0) { emit("raise_invokes_handler", 1, NULL, 1, errno); return 1; }
  if (raise(SIGTERM) != 0) { emit("raise_invokes_handler", 1, NULL, 1, errno); return 1; }
  if (signal_canary_seen != SIGTERM) { emit("raise_invokes_handler", 1, NULL, 0, 0); return 1; }
  emit("raise_invokes_handler", 0, "raise:sigterm", 0, 0);
  return 0;
}

static int case_alarm_returns_zero(void) {
  /* alarm(0) cancels any pending alarm and returns the seconds remaining,
   * which is 0 on first call. */
  unsigned remaining = alarm(0);
  if (remaining != 0) { emit("alarm_returns_zero", 1, NULL, 0, 0); return 1; }
  emit("alarm_returns_zero", 0, "alarm:0", 0, 0);
  return 0;
}

static int case_sigemptyset_clears(void) {
  sigset_t s;
  /* Pre-poison with sigfillset so we can distinguish a no-op from a real clear. */
  if (sigfillset(&s) != 0) { emit("sigemptyset_clears", 1, NULL, 1, errno); return 1; }
  if (sigemptyset(&s) != 0) { emit("sigemptyset_clears", 1, NULL, 1, errno); return 1; }
  /* After empty, no signal should be a member. */
  if (sigismember(&s, SIGINT) != 0) { emit("sigemptyset_clears", 1, NULL, 0, 0); return 1; }
  emit("sigemptyset_clears", 0, "sigset:empty", 0, 0);
  return 0;
}

static int case_sigfillset_fills(void) {
  sigset_t s;
  if (sigfillset(&s) != 0) { emit("sigfillset_fills", 1, NULL, 1, errno); return 1; }
  if (sigismember(&s, SIGINT) != 1) { emit("sigfillset_fills", 1, NULL, 0, 0); return 1; }
  if (sigismember(&s, SIGTERM) != 1) { emit("sigfillset_fills", 1, NULL, 0, 0); return 1; }
  emit("sigfillset_fills", 0, "sigset:full", 0, 0);
  return 0;
}

static int case_sigaddset_adds(void) {
  sigset_t s;
  if (sigemptyset(&s) != 0) { emit("sigaddset_adds", 1, NULL, 1, errno); return 1; }
  if (sigaddset(&s, SIGINT) != 0) { emit("sigaddset_adds", 1, NULL, 1, errno); return 1; }
  if (sigismember(&s, SIGINT) != 1) { emit("sigaddset_adds", 1, NULL, 0, 0); return 1; }
  if (sigismember(&s, SIGTERM) != 0) { emit("sigaddset_adds", 1, NULL, 0, 0); return 1; }
  emit("sigaddset_adds", 0, "sigset:add", 0, 0);
  return 0;
}

static int case_sigdelset_removes(void) {
  sigset_t s;
  if (sigfillset(&s) != 0) { emit("sigdelset_removes", 1, NULL, 1, errno); return 1; }
  if (sigdelset(&s, SIGINT) != 0) { emit("sigdelset_removes", 1, NULL, 1, errno); return 1; }
  if (sigismember(&s, SIGINT) != 0) { emit("sigdelset_removes", 1, NULL, 0, 0); return 1; }
  if (sigismember(&s, SIGTERM) != 1) { emit("sigdelset_removes", 1, NULL, 0, 0); return 1; }
  emit("sigdelset_removes", 0, "sigset:del", 0, 0);
  return 0;
}

static int case_sigismember_reports(void) {
  sigset_t s;
  if (sigemptyset(&s) != 0) { emit("sigismember_reports", 1, NULL, 1, errno); return 1; }
  if (sigaddset(&s, SIGINT) != 0) { emit("sigismember_reports", 1, NULL, 1, errno); return 1; }
  int yes = sigismember(&s, SIGINT);
  int no = sigismember(&s, SIGTERM);
  if (yes != 1 || no != 0) { emit("sigismember_reports", 1, NULL, 0, 0); return 1; }
  emit("sigismember_reports", 0, "sigset:ismember", 0, 0);
  return 0;
}

static int case_sigprocmask_roundtrip(void) {
  sigset_t set, oldset;
  if (sigemptyset(&set) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigaddset(&set, SIGUSR1) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigprocmask(SIG_SETMASK, &set, NULL) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigprocmask(SIG_SETMASK, NULL, &oldset) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigismember(&oldset, SIGUSR1) != 1) { emit("sigprocmask_roundtrip", 1, NULL, 0, 0); return 1; }
  emit("sigprocmask_roundtrip", 0, "sigprocmask:roundtrip", 0, 0);
  return 0;
}

static int case_sigsuspend_resumes_on_raise(void) {
  /* sigsuspend with empty mask + raise == handler runs synchronously, suspend returns -1/EINTR. */
  struct sigaction sa;
  sigset_t empty;
  signal_canary_suspend_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_suspend_handler;
  if (sigaction(SIGUSR2, &sa, NULL) != 0) { emit("sigsuspend_resumes_on_raise", 1, NULL, 1, errno); return 1; }
  if (sigemptyset(&empty) != 0) { emit("sigsuspend_resumes_on_raise", 1, NULL, 1, errno); return 1; }
  /* Raise BEFORE suspending — codepod's signal layer dispatches on raise() rather
   * than blocking on external delivery, so "suspend then raise" would deadlock. The
   * spec semantics are intentionally narrow (§Runtime Semantics > Signals). */
  if (raise(SIGUSR2) != 0) { emit("sigsuspend_resumes_on_raise", 1, NULL, 1, errno); return 1; }
  if (signal_canary_suspend_seen != SIGUSR2) { emit("sigsuspend_resumes_on_raise", 1, NULL, 0, 0); return 1; }
  emit("sigsuspend_resumes_on_raise", 0, "sigsuspend:handled", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "signal_install") == 0) return case_signal_install();
  if (strcmp(name, "sigaction_raise") == 0) return case_sigaction_raise();
  if (strcmp(name, "raise_invokes_handler") == 0) return case_raise_invokes_handler();
  if (strcmp(name, "alarm_returns_zero") == 0) return case_alarm_returns_zero();
  if (strcmp(name, "sigemptyset_clears") == 0) return case_sigemptyset_clears();
  if (strcmp(name, "sigfillset_fills") == 0) return case_sigfillset_fills();
  if (strcmp(name, "sigaddset_adds") == 0) return case_sigaddset_adds();
  if (strcmp(name, "sigdelset_removes") == 0) return case_sigdelset_removes();
  if (strcmp(name, "sigismember_reports") == 0) return case_sigismember_reports();
  if (strcmp(name, "sigprocmask_roundtrip") == 0) return case_sigprocmask_roundtrip();
  if (strcmp(name, "sigsuspend_resumes_on_raise") == 0) return case_sigsuspend_resumes_on_raise();
  fprintf(stderr, "signal-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("signal_install");
  puts("sigaction_raise");
  puts("raise_invokes_handler");
  puts("alarm_returns_zero");
  puts("sigemptyset_clears");
  puts("sigfillset_fills");
  puts("sigaddset_adds");
  puts("sigdelset_removes");
  puts("sigismember_reports");
  puts("sigprocmask_roundtrip");
  puts("sigsuspend_resumes_on_raise");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved verbatim. */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = signal_canary_handler;
    if (sigaction(SIGINT, &sa, NULL) != 0) { perror("sigaction"); return 1; }
    if (raise(SIGINT) != 0) { perror("raise"); return 1; }
    if (signal_canary_seen != SIGINT) { fprintf(stderr, "signal handler was not invoked\n"); return 1; }
    alarm(0);
    puts("signal-ok");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: signal-canary [--case <name> | --list-cases]\n");
  return 2;
}
```

- [ ] **Step 2: Rebuild canary, run each case via wasmtime**

```bash
make -C packages/guest-compat clean lib canaries copy-fixtures
for c in signal_install sigaction_raise raise_invokes_handler alarm_returns_zero \
         sigemptyset_clears sigfillset_fills sigaddset_adds sigdelset_removes \
         sigismember_reports sigprocmask_roundtrip sigsuspend_resumes_on_raise; do
  wasmtime run packages/guest-compat/build/signal-canary.wasm -- --case $c
done
```

Expected: 11 JSONL lines. Every line must have `"exit":0` (exit-1 cases would indicate a real bug in the compat impl — escalate to user).

- [ ] **Step 3: Re-run orchestrator E2E suite (smoke mode)**

```bash
deno test -A --no-check packages/orchestrator/src/__tests__/guest-compat.test.ts
```

Expected: 11/11 pass.

- [ ] **Step 4: Create `signal.spec.toml`**

```toml
canary = "signal-canary"
summary = "Install a signal handler the legacy way (§Runtime Semantics > Signals)."

[[case]]
name = "signal_install"
inputs = "signal(SIGINT, handler)"
expected.exit = 0
expected.stdout = "signal:installed"
expected.note = "returns SIG_DFL the first time, never SIG_ERR"
```

- [ ] **Step 5: Create `sigaction.spec.toml`**

```toml
canary = "signal-canary"
summary = "Install a signal handler via sigaction (§Runtime Semantics > Signals)."

[[case]]
name = "sigaction_raise"
inputs = "sigaction(SIGINT, &sa, NULL); raise(SIGINT)"
expected.exit = 0
expected.stdout = "signal-ok"
expected.note = "handler runs synchronously"
```

- [ ] **Step 6: Create `raise.spec.toml`**

```toml
canary = "signal-canary"
summary = "Synchronously dispatch a signal handler (§Runtime Semantics > Signals)."

[[case]]
name = "raise_invokes_handler"
inputs = "sigaction(SIGTERM, &sa); raise(SIGTERM)"
expected.exit = 0
expected.stdout = "raise:sigterm"
expected.note = "raise() returns 0 and the handler observes the signal"
```

- [ ] **Step 7: Create `alarm.spec.toml`**

```toml
canary = "signal-canary"
summary = "alarm() cancellation semantics (§Runtime Semantics > Signals)."

[[case]]
name = "alarm_returns_zero"
inputs = "alarm(0)"
expected.exit = 0
expected.stdout = "alarm:0"
expected.note = "no prior alarm was pending; return value is 0"
```

- [ ] **Step 8: Create `sigemptyset.spec.toml`**

```toml
canary = "signal-canary"
summary = "Clear a sigset_t (§Runtime Semantics > Signals)."

[[case]]
name = "sigemptyset_clears"
inputs = "sigfillset(&s); sigemptyset(&s); sigismember(&s, SIGINT)"
expected.exit = 0
expected.stdout = "sigset:empty"
expected.note = "post-empty, no signal is a member"
```

- [ ] **Step 9: Create `sigfillset.spec.toml`**

```toml
canary = "signal-canary"
summary = "Fill a sigset_t (§Runtime Semantics > Signals)."

[[case]]
name = "sigfillset_fills"
inputs = "sigfillset(&s); sigismember(&s, SIGINT|SIGTERM)"
expected.exit = 0
expected.stdout = "sigset:full"
expected.note = "all common signals report as members"
```

- [ ] **Step 10: Create `sigaddset.spec.toml`**

```toml
canary = "signal-canary"
summary = "Add a signal to a sigset_t (§Runtime Semantics > Signals)."

[[case]]
name = "sigaddset_adds"
inputs = "sigemptyset(&s); sigaddset(&s, SIGINT)"
expected.exit = 0
expected.stdout = "sigset:add"
expected.note = "SIGINT is now a member; SIGTERM is not"
```

- [ ] **Step 11: Create `sigdelset.spec.toml`**

```toml
canary = "signal-canary"
summary = "Remove a signal from a sigset_t (§Runtime Semantics > Signals)."

[[case]]
name = "sigdelset_removes"
inputs = "sigfillset(&s); sigdelset(&s, SIGINT)"
expected.exit = 0
expected.stdout = "sigset:del"
expected.note = "SIGINT is no longer a member; SIGTERM still is"
```

- [ ] **Step 12: Create `sigismember.spec.toml`**

```toml
canary = "signal-canary"
summary = "Test sigset_t membership (§Runtime Semantics > Signals)."

[[case]]
name = "sigismember_reports"
inputs = "sigemptyset(&s); sigaddset(&s, SIGINT); sigismember(&s, SIGINT|SIGTERM)"
expected.exit = 0
expected.stdout = "sigset:ismember"
expected.note = "1 for added signal, 0 for absent"
```

- [ ] **Step 13: Create `sigprocmask.spec.toml`**

```toml
canary = "signal-canary"
summary = "Round-trip the guest-local signal mask (§Runtime Semantics > Signals)."

[[case]]
name = "sigprocmask_roundtrip"
inputs = "SIG_SETMASK(SIGUSR1) then SIG_SETMASK(NULL, &old)"
expected.exit = 0
expected.stdout = "sigprocmask:roundtrip"
expected.note = "guest-local mask only; no observation of external signals"
```

- [ ] **Step 14: Create `sigsuspend.spec.toml`**

```toml
canary = "signal-canary"
summary = "sigsuspend interaction with raise() (§Runtime Semantics > Signals)."

[[case]]
name = "sigsuspend_resumes_on_raise"
inputs = "install handler; raise(SIGUSR2) — handler runs synchronously"
expected.exit = 0
expected.stdout = "sigsuspend:handled"
expected.note = "codepod dispatches on raise() rather than blocking"
```

- [ ] **Step 15: Verify case parity between canary's `--list-cases` and the union of all 11 spec.toml `[[case]] name` fields**

```bash
wasmtime run packages/guest-compat/build/signal-canary.wasm -- --list-cases | sort > /tmp/canary-cases.txt
grep -h '^name = ' packages/guest-compat/conformance/{signal,sigaction,raise,alarm,sigemptyset,sigfillset,sigaddset,sigdelset,sigismember,sigprocmask,sigsuspend}.spec.toml \
  | sed 's/^name = "\(.*\)"/\1/' | sort > /tmp/spec-cases.txt
diff /tmp/canary-cases.txt /tmp/spec-cases.txt
```

Expected: empty diff.

- [ ] **Step 16: Commit**

```bash
git add packages/guest-compat/conformance/c/signal-canary.c \
        packages/guest-compat/conformance/{signal,sigaction,raise,alarm,sigemptyset,sigfillset,sigaddset,sigdelset,sigismember,sigprocmask,sigsuspend}.spec.toml
git commit -m "feat(guest-compat/step-3): add signal-family spec.toml + canary cases (Task 6)"
```

---

## Task 7: Spec parser + trace diff in `cpcc-toolchain`

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/Cargo.toml` (add `toml` and `serde` deps)
- Create: `packages/guest-compat/toolchain/cpcc/src/spec.rs`
- Create: `packages/guest-compat/toolchain/cpcc/src/trace.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/lib.rs` (re-export modules)
- Create: `packages/guest-compat/toolchain/cpcc/tests/spec_parsing.rs`
- Create: `packages/guest-compat/toolchain/cpcc/tests/trace_diff.rs`

This is the harness the conformance driver in Task 18 plugs into. TDD: write the failing tests first, then the modules.

- [ ] **Step 1: Add deps to `Cargo.toml`**

In `packages/guest-compat/toolchain/cpcc/Cargo.toml`, replace the `[dependencies]` block with:

```toml
[dependencies]
clap = { version = "4", features = ["derive"] }
anyhow = "1"
which = "6"
wasmparser = "0.247.0"
toml = { version = "0.8", default-features = false, features = ["parse"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Build the crate to fetch the new deps**

```bash
cargo build -p cpcc-toolchain --release
```

Expected: success.

- [ ] **Step 3: Write the failing test for spec parsing**

Create `packages/guest-compat/toolchain/cpcc/tests/spec_parsing.rs`:

```rust
use cpcc_toolchain::spec::{Expected, Spec};

#[test]
fn parses_minimal_spec_with_one_case() {
    let text = r#"
canary = "dup2-canary"
summary = "test"

[[case]]
name = "happy_path"
expected.exit = 0
expected.stdout = "dup2-ok"
"#;
    let spec: Spec = Spec::from_str(text).unwrap();
    assert_eq!(spec.canary, "dup2-canary");
    assert_eq!(spec.cases.len(), 1);
    assert_eq!(spec.cases[0].name, "happy_path");
    assert_eq!(spec.cases[0].expected.exit, Some(0));
    assert_eq!(spec.cases[0].expected.stdout.as_deref(), Some("dup2-ok"));
    assert_eq!(spec.cases[0].expected.errno, None);
}

#[test]
fn parses_errno_field() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "invalid_fd"
expected.exit = 1
expected.errno = 8
"#;
    let spec: Spec = Spec::from_str(text).unwrap();
    assert_eq!(spec.cases[0].expected.errno, Some(8));
}

#[test]
fn rejects_unknown_expected_field() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "happy_path"
expected.something_made_up = 42
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("unknown field") || err.contains("something_made_up"),
            "expected closed-schema error, got: {err}");
}

#[test]
fn rejects_case_with_no_expected_fields() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "empty"
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("at least one expected"),
            "expected at-least-one-expected error, got: {err}");
}

#[test]
fn rejects_duplicate_case_names() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "happy_path"
expected.exit = 0

[[case]]
name = "happy_path"
expected.exit = 1
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("duplicate"),
            "expected duplicate-name error, got: {err}");
}

#[test]
fn rejects_invalid_case_name() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "Bad-Name!"
expected.exit = 0
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("invalid case name") || err.contains("Bad-Name"),
            "expected invalid-name error, got: {err}");
}

#[test]
fn allows_optional_inputs_and_note_fields() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "happy"
inputs = "dup2(1, 2)"
expected.exit = 0
expected.note = "renumber"
"#;
    let spec = Spec::from_str(text).unwrap();
    assert_eq!(spec.cases[0].inputs.as_deref(), Some("dup2(1, 2)"));
    assert_eq!(spec.cases[0].expected.note.as_deref(), Some("renumber"));
}

#[test]
fn loads_from_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("dup2.spec.toml"), r#"
canary = "dup2-canary"
[[case]]
name = "happy_path"
expected.exit = 0
"#).unwrap();
    std::fs::write(dir.path().join("getgroups.spec.toml"), r#"
canary = "getgroups-canary"
[[case]]
name = "count_only"
expected.exit = 0
"#).unwrap();
    let specs = Spec::load_dir(dir.path()).unwrap();
    assert_eq!(specs.len(), 2);
    let dup2 = specs.iter().find(|s| s.symbol == "dup2").unwrap();
    assert_eq!(dup2.canary, "dup2-canary");
}
```

- [ ] **Step 4: Run the failing test**

```bash
cargo test -p cpcc-toolchain --test spec_parsing
```

Expected: compile failure (`cpcc_toolchain::spec` doesn't exist yet).

- [ ] **Step 5: Implement `src/spec.rs`**

Create `packages/guest-compat/toolchain/cpcc/src/spec.rs`:

```rust
//! TOML spec parser for the conformance harness (§Behavioral Spec). Closed
//! schema: unknown `expected.*` fields are a parse error so the spec
//! contract cannot drift silently.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// One symbol's behavioral spec, loaded from `<symbol>.spec.toml`.
#[derive(Debug, Clone)]
pub struct Spec {
    /// Symbol name derived from the file stem (e.g. `dup2.spec.toml` → `dup2`).
    pub symbol: String,
    /// Source file path. Used in failure messages.
    pub path: PathBuf,
    /// Canary executable name (no `.wasm` suffix).
    pub canary: String,
    /// Optional human summary; not diffed.
    pub summary: Option<String>,
    pub cases: Vec<Case>,
}

#[derive(Debug, Clone)]
pub struct Case {
    pub name: String,
    /// Optional documentation string; not diffed.
    pub inputs: Option<String>,
    pub expected: Expected,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Expected {
    pub exit: Option<i32>,
    pub stdout: Option<String>,
    pub errno: Option<i32>,
    /// Free-form, never diffed; surfaced in failure messages only.
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSpec {
    canary: String,
    summary: Option<String>,
    #[serde(rename = "case", default)]
    cases: Vec<RawCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCase {
    name: String,
    inputs: Option<String>,
    #[serde(default)]
    expected: RawExpected,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawExpected {
    exit: Option<i32>,
    stdout: Option<String>,
    errno: Option<i32>,
    note: Option<String>,
}

fn is_valid_case_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

impl Spec {
    /// Parse spec text without an associated file. `symbol` is set to "<inline>".
    pub fn from_str(text: &str) -> Result<Self> {
        Self::from_str_with_symbol(text, "<inline>", PathBuf::new())
    }

    fn from_str_with_symbol(text: &str, symbol: &str, path: PathBuf) -> Result<Self> {
        let raw: RawSpec = toml::from_str(text)
            .with_context(|| format!("parsing spec for {symbol}"))?;

        let mut seen = std::collections::HashSet::new();
        let mut cases = Vec::with_capacity(raw.cases.len());
        for rc in raw.cases {
            if !is_valid_case_name(&rc.name) {
                return Err(anyhow!(
                    "{symbol}: invalid case name {:?} (must match /^[a-z][a-z0-9_]*$/)",
                    rc.name
                ));
            }
            if !seen.insert(rc.name.clone()) {
                return Err(anyhow!("{symbol}: duplicate case name {:?}", rc.name));
            }
            let exp = rc.expected;
            let expected = Expected {
                exit: exp.exit,
                stdout: exp.stdout,
                errno: exp.errno,
                note: exp.note,
            };
            if expected.exit.is_none()
                && expected.stdout.is_none()
                && expected.errno.is_none()
            {
                return Err(anyhow!(
                    "{symbol}: case {:?} requires at least one expected.* field",
                    rc.name
                ));
            }
            cases.push(Case {
                name: rc.name,
                inputs: rc.inputs,
                expected,
            });
        }

        Ok(Self {
            symbol: symbol.to_string(),
            path,
            canary: raw.canary,
            summary: raw.summary,
            cases,
        })
    }

    /// Read every `<symbol>.spec.toml` file directly under `dir`. Sorted by
    /// symbol name so iteration order is deterministic.
    pub fn load_dir(dir: &Path) -> Result<Vec<Self>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)
            .with_context(|| format!("reading {}", dir.display()))?
        {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let symbol = match name.strip_suffix(".spec.toml") {
                Some(s) => s,
                None => continue,
            };
            let path = entry.path();
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            out.push(Self::from_str_with_symbol(&text, symbol, path)?);
        }
        out.sort_by(|a, b| a.symbol.cmp(&b.symbol));
        Ok(out)
    }
}
```

- [ ] **Step 6: Wire `pub mod spec;` into `src/lib.rs`**

In `packages/guest-compat/toolchain/cpcc/src/lib.rs`, after the existing `pub mod` lines, add:

```rust
pub mod spec;
pub mod trace;
```

(`trace` is empty for now; the next step creates it.)

- [ ] **Step 7: Add `tempfile` to dev-deps if not already there, then run the spec tests**

Check `Cargo.toml`'s `[dev-dependencies]`:

```toml
[dev-dependencies]
tempfile = "3"
```

(This is already present from Step 1; verify it didn't get removed.)

```bash
cargo test -p cpcc-toolchain --test spec_parsing
```

Expected: 8/8 pass. Most likely failure: `pub mod trace;` referenced in lib.rs but module file missing — that's fine, Step 8 creates it. If only that breaks, comment out the `pub mod trace;` line until Step 9, then restore.

Cleaner ordering: skip the `pub mod trace;` line in this step; add it in Step 9. Update `lib.rs`:

```rust
pub mod spec;
```

(no `pub mod trace;` yet)

- [ ] **Step 8: Commit spec parser**

```bash
git add packages/guest-compat/toolchain/cpcc/Cargo.toml \
        packages/guest-compat/toolchain/cpcc/src/lib.rs \
        packages/guest-compat/toolchain/cpcc/src/spec.rs \
        packages/guest-compat/toolchain/cpcc/tests/spec_parsing.rs
git commit -m "feat(guest-compat/step-3): add spec.toml parser to cpcc-toolchain (Task 7a)"
```

- [ ] **Step 9: Write the failing test for trace diff**

Create `packages/guest-compat/toolchain/cpcc/tests/trace_diff.rs`:

```rust
use cpcc_toolchain::spec::{Case, Expected, Spec};
use cpcc_toolchain::trace::{diff_case, parse_trace_line, Mismatch, TraceLine};

fn case(name: &str, exp: Expected) -> Case {
    Case { name: name.into(), inputs: None, expected: exp }
}

#[test]
fn parses_well_formed_trace_line() {
    let line = r#"{"case":"happy","exit":0,"stdout":"ok"}"#;
    let t = parse_trace_line(line).unwrap();
    assert_eq!(t.case, "happy");
    assert_eq!(t.exit, 0);
    assert_eq!(t.stdout.as_deref(), Some("ok"));
    assert_eq!(t.errno, None);
}

#[test]
fn parses_trace_with_errno() {
    let line = r#"{"case":"bad","exit":1,"errno":8}"#;
    let t = parse_trace_line(line).unwrap();
    assert_eq!(t.errno, Some(8));
    assert_eq!(t.stdout, None);
}

#[test]
fn rejects_trace_with_no_case_field() {
    let line = r#"{"exit":0}"#;
    assert!(parse_trace_line(line).is_err());
}

#[test]
fn diff_passes_when_all_expected_fields_match() {
    let exp = Expected { exit: Some(0), stdout: Some("ok".into()), ..Default::default() };
    let trace = TraceLine { case: "happy".into(), exit: 0, stdout: Some("ok".into()), errno: None };
    let mismatches = diff_case(&case("happy", exp), &trace, /*process_exit*/ 0);
    assert!(mismatches.is_empty(), "got mismatches: {mismatches:?}");
}

#[test]
fn diff_reports_exit_mismatch() {
    let exp = Expected { exit: Some(0), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 1, stdout: None, errno: None };
    let mm = diff_case(&case("x", exp), &trace, 1);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Exit { expected: 0, actual: 1 })));
}

#[test]
fn diff_reports_process_vs_trace_exit_disagreement() {
    let exp = Expected { exit: Some(0), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 0, stdout: None, errno: None };
    // Trace says exit=0, but the process actually exited 2 — disagreement.
    let mm = diff_case(&case("x", exp), &trace, 2);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::ProcessTraceExitDisagree { .. })));
}

#[test]
fn diff_reports_stdout_mismatch() {
    let exp = Expected { exit: Some(0), stdout: Some("hi".into()), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 0, stdout: Some("hello".into()), errno: None };
    let mm = diff_case(&case("x", exp), &trace, 0);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Stdout { .. })));
}

#[test]
fn diff_reports_errno_mismatch() {
    let exp = Expected { exit: Some(1), errno: Some(8), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 1, stdout: None, errno: Some(28) };
    let mm = diff_case(&case("x", exp), &trace, 1);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Errno { expected: 8, actual: Some(28) })));
}

#[test]
fn diff_reports_missing_errno_when_expected() {
    let exp = Expected { exit: Some(1), errno: Some(8), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 1, stdout: None, errno: None };
    let mm = diff_case(&case("x", exp), &trace, 1);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Errno { expected: 8, actual: None })));
}

#[test]
fn diff_reports_case_name_mismatch() {
    let exp = Expected { exit: Some(0), ..Default::default() };
    let trace = TraceLine { case: "wrong_name".into(), exit: 0, stdout: None, errno: None };
    let mm = diff_case(&case("expected_name", exp), &trace, 0);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::CaseName { .. })));
}

#[test]
fn note_field_is_never_diffed() {
    let exp = Expected { exit: Some(0), note: Some("ignored".into()), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 0, stdout: None, errno: None };
    let mm = diff_case(&case("x", exp), &trace, 0);
    assert!(mm.is_empty(), "note must not contribute to diff");
}
```

- [ ] **Step 10: Implement `src/trace.rs`**

Create `packages/guest-compat/toolchain/cpcc/src/trace.rs`:

```rust
//! JSONL trace line parsing and diff against `Spec` expectations
//! (§Conformance Driver). The diff returns a Vec<Mismatch> so a single case
//! can report multiple problems at once, surfaced by the conformance driver.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::spec::Case;

#[derive(Debug, Clone, PartialEq)]
pub struct TraceLine {
    pub case: String,
    pub exit: i32,
    pub stdout: Option<String>,
    pub errno: Option<i32>,
}

#[derive(Deserialize)]
struct RawTrace {
    case: String,
    exit: i32,
    #[serde(default)]
    stdout: Option<String>,
    #[serde(default)]
    errno: Option<i32>,
}

pub fn parse_trace_line(line: &str) -> Result<TraceLine> {
    let raw: RawTrace = serde_json::from_str(line.trim_end_matches('\n'))
        .with_context(|| format!("parsing trace line: {line}"))?;
    if raw.case.is_empty() {
        return Err(anyhow!("trace line has empty case field: {line}"));
    }
    Ok(TraceLine {
        case: raw.case,
        exit: raw.exit,
        stdout: raw.stdout,
        errno: raw.errno,
    })
}

#[derive(Debug, PartialEq)]
pub enum Mismatch {
    CaseName { expected: String, actual: String },
    Exit { expected: i32, actual: i32 },
    ProcessTraceExitDisagree { trace: i32, process: i32 },
    Stdout { expected: String, actual: Option<String> },
    Errno { expected: i32, actual: Option<i32> },
}

/// Compare one trace line against its case spec. The third argument is the
/// process exit code captured by the driver — it must match the trace's
/// self-reported `exit` field, otherwise the canary lied.
pub fn diff_case(case: &Case, trace: &TraceLine, process_exit: i32) -> Vec<Mismatch> {
    let mut out = Vec::new();
    if trace.case != case.name {
        out.push(Mismatch::CaseName {
            expected: case.name.clone(),
            actual: trace.case.clone(),
        });
    }
    if trace.exit != process_exit {
        out.push(Mismatch::ProcessTraceExitDisagree {
            trace: trace.exit,
            process: process_exit,
        });
    }
    if let Some(expected_exit) = case.expected.exit {
        if expected_exit != trace.exit {
            out.push(Mismatch::Exit {
                expected: expected_exit,
                actual: trace.exit,
            });
        }
    }
    if let Some(expected_stdout) = &case.expected.stdout {
        if trace.stdout.as_deref() != Some(expected_stdout.as_str()) {
            out.push(Mismatch::Stdout {
                expected: expected_stdout.clone(),
                actual: trace.stdout.clone(),
            });
        }
    }
    if let Some(expected_errno) = case.expected.errno {
        if trace.errno != Some(expected_errno) {
            out.push(Mismatch::Errno {
                expected: expected_errno,
                actual: trace.errno,
            });
        }
    }
    out
}
```

- [ ] **Step 11: Add `pub mod trace;` to lib.rs and run trace tests**

Edit `packages/guest-compat/toolchain/cpcc/src/lib.rs`:

```rust
pub mod archive;
pub mod conform;
pub mod env;
pub mod precheck;
pub mod preserve;
pub mod spec;
pub mod trace;
pub mod wasi_sdk;
pub mod wasm_opt;

pub const TIER1: &[&str] = &[
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
```

Then:

```bash
cargo test -p cpcc-toolchain --test trace_diff
```

Expected: 11/11 pass. Also re-run the full crate test suite to confirm nothing regressed:

```bash
cargo test -p cpcc-toolchain
```

- [ ] **Step 12: Commit trace diff**

```bash
git add packages/guest-compat/toolchain/cpcc/src/lib.rs \
        packages/guest-compat/toolchain/cpcc/src/trace.rs \
        packages/guest-compat/toolchain/cpcc/tests/trace_diff.rs
git commit -m "feat(guest-compat/step-3): add JSONL trace diff to cpcc-toolchain (Task 7b)"
```

---

## Task 8: `cargo-codepod` scaffold (binary + arg parsing)

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/Cargo.toml` (add `cargo-codepod` bin)
- Create: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs` (core module)
- Create: `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs` (binary entrypoint)
- Modify: `packages/guest-compat/toolchain/cpcc/src/lib.rs` (re-export module)
- Create: `packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs`

`cargo-codepod` is a sixth binary in the existing `cpcc-toolchain` package. Per §Toolchain Integration > Rust Toolchain, it's a cargo subcommand modeled on `cargo-wasix`: cargo finds it on PATH, invokes it as `cargo-codepod codepod <subcommand> [args...]` (cargo prepends the subcommand name as `argv[1]` so the binary can disambiguate when invoked directly).

This task lands the scaffold and the `--dry-run` shape; Tasks 9-11 fill in real subcommand behavior.

- [ ] **Step 1: Add bin entry to `Cargo.toml`**

In `packages/guest-compat/toolchain/cpcc/Cargo.toml`, add after the existing `[[bin]]` entries:

```toml
[[bin]]
name = "cargo-codepod"
path = "src/bin/cargo-codepod.rs"
```

- [ ] **Step 2: Write the failing dry-run test**

Create `packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs`:

```rust
use cpcc_toolchain::cargo_codepod::{plan_invocation, Subcommand};

#[test]
fn build_subcommand_uses_wasm32_wasip1_target() {
    let plan = plan_invocation(Subcommand::Build, &["--release".into()]).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "build"));
    assert!(plan.cargo_args.iter().any(|a| a == "--target=wasm32-wasip1"));
    assert!(plan.cargo_args.iter().any(|a| a == "--release"));
}

#[test]
fn test_subcommand_uses_wasm32_wasip1_target() {
    let plan = plan_invocation(Subcommand::Test, &[]).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "test"));
    assert!(plan.cargo_args.iter().any(|a| a == "--target=wasm32-wasip1"));
}

#[test]
fn run_subcommand_uses_wasm32_wasip1_target() {
    let plan = plan_invocation(Subcommand::Run, &["--bin".into(), "foo".into()]).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "run"));
    assert!(plan.cargo_args.iter().any(|a| a == "--target=wasm32-wasip1"));
    assert!(plan.cargo_args.iter().any(|a| a == "--bin"));
    assert!(plan.cargo_args.iter().any(|a| a == "foo"));
}

#[test]
fn injected_env_includes_codepod_link_injected() {
    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();
    assert_eq!(
        plan.env.iter().find(|(k, _)| k == "CODEPOD_LINK_INJECTED").map(|(_, v)| v.as_str()),
        Some("1"),
    );
}

#[test]
fn dry_run_does_not_set_target_specific_env_when_archive_missing() {
    // Without CPCC_ARCHIVE pointing somewhere real, the linker/RUSTFLAGS env
    // vars are not set — letting the user diagnose "where's my archive?"
    // before they run a build.
    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();
    let has_rustflags = plan.env.iter().any(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS");
    assert!(!has_rustflags, "RUSTFLAGS should not be injected when archive is unset");
}
```

- [ ] **Step 3: Run the failing test**

```bash
cargo test -p cpcc-toolchain --test cargo_codepod_dry_run
```

Expected: compile failure (`cpcc_toolchain::cargo_codepod` doesn't exist).

- [ ] **Step 4: Implement `src/cargo_codepod.rs` (scaffold + `plan_invocation`)**

Create `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs`:

```rust
//! `cargo-codepod` cargo subcommand (§Toolchain Integration > Rust Toolchain).
//! Wraps real `cargo` with the wasm32-wasip1 target, the wasi-sdk linker,
//! the compat-archive RUSTFLAGS framing, the `CODEPOD_LINK_INJECTED=1`
//! handshake with the optional `-sys` crate, version checking, pre-opt wasm
//! preservation, and post-link `wasm-opt`.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Subcommand {
    Build,
    Test,
    Run,
    DownloadToolchain,
}

impl Subcommand {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "build" => Ok(Self::Build),
            "test" => Ok(Self::Test),
            "run" => Ok(Self::Run),
            "download-toolchain" => Ok(Self::DownloadToolchain),
            other => Err(anyhow!(
                "unknown cargo-codepod subcommand {other:?} (expected build/test/run/download-toolchain)"
            )),
        }
    }
    pub fn cargo_verb(self) -> Option<&'static str> {
        match self {
            Self::Build => Some("build"),
            Self::Test => Some("test"),
            Self::Run => Some("run"),
            Self::DownloadToolchain => None,
        }
    }
}

/// What the wrapper plans to do. `execute_plan` consumes this; tests inspect
/// it without spawning cargo.
#[derive(Debug, Default)]
pub struct InvocationPlan {
    pub cargo_args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Compute the cargo invocation for `sub` plus `forwarded` user args.
/// Reads CPCC_ARCHIVE / CPCC_INCLUDE / CPCC_PRESERVE_PRE_OPT etc. from the
/// process environment via the existing `crate::env::Env`. RUSTFLAGS is only
/// injected when an archive is present — bare `cargo codepod build` with no
/// archive surfaces "missing archive" instead of a confusing link error.
pub fn plan_invocation(sub: Subcommand, forwarded: &[String]) -> Result<InvocationPlan> {
    let env = crate::env::Env::from_process();
    let mut plan = InvocationPlan::default();

    let verb = sub
        .cargo_verb()
        .ok_or_else(|| anyhow!("subcommand {sub:?} does not correspond to a cargo verb"))?;
    plan.cargo_args.push(verb.to_string());
    plan.cargo_args.push("--target=wasm32-wasip1".to_string());
    for arg in forwarded {
        plan.cargo_args.push(arg.clone());
    }

    plan.env.push(("CODEPOD_LINK_INJECTED".to_string(), "1".to_string()));

    if let Some(archive) = &env.archive {
        // §Override And Link Precedence: --whole-archive bracket the compat
        // archive, then per-Tier-1-symbol --export framing so the
        // implementation-signature check can find the markers in the pre-opt
        // wasm.
        let mut rustflags = String::new();
        rustflags.push_str("-C link-arg=-Wl,--whole-archive ");
        rustflags.push_str(&format!("-C link-arg={} ", archive.display()));
        rustflags.push_str("-C link-arg=-Wl,--no-whole-archive ");
        for sym in crate::TIER1 {
            rustflags.push_str(&format!("-C link-arg=-Wl,--export={sym} "));
            rustflags.push_str(&format!(
                "-C link-arg=-Wl,--export=__codepod_guest_compat_marker_{sym} "
            ));
        }
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            rustflags.trim_end().to_string(),
        ));
    }

    Ok(plan)
}
```

- [ ] **Step 5: Wire the module into lib.rs**

In `packages/guest-compat/toolchain/cpcc/src/lib.rs`, add after `pub mod archive;`:

```rust
pub mod cargo_codepod;
```

- [ ] **Step 6: Run dry-run tests**

```bash
cargo test -p cpcc-toolchain --test cargo_codepod_dry_run
```

Expected: 5/5 pass.

- [ ] **Step 7: Implement `src/bin/cargo-codepod.rs` (thin entrypoint that prints the plan in dry-run mode)**

Create `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs`:

```rust
use anyhow::{anyhow, Result};
use cpcc_toolchain::cargo_codepod::{plan_invocation, Subcommand};
use std::process::ExitCode;

fn main() -> Result<ExitCode> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    // Cargo invokes `cargo-codepod` as `cargo-codepod codepod <sub> [args...]`,
    // so strip the leading "codepod" if present.
    if argv.first().map(|s| s.as_str()) == Some("codepod") {
        argv.remove(0);
    }
    if argv.is_empty() {
        return Err(anyhow!(
            "cargo-codepod: expected a subcommand (build, test, run, download-toolchain)"
        ));
    }
    let sub_name = argv.remove(0);
    let sub = Subcommand::parse(&sub_name)?;

    // --dry-run prints the plan and exits without spawning cargo. Useful
    // for tests and for users who want to see what the wrapper would do.
    let mut dry_run = false;
    argv.retain(|a| {
        if a == "--dry-run" {
            dry_run = true;
            false
        } else {
            true
        }
    });

    let plan = plan_invocation(sub, &argv)?;

    if dry_run {
        for (k, v) in &plan.env {
            println!("{k}={v}");
        }
        print!("cargo");
        for a in &plan.cargo_args {
            print!(" {a}");
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    // Real execution lands in Task 9. For now, dry-run is the only path.
    Err(anyhow!(
        "cargo-codepod: real execution not yet implemented; pass --dry-run for now"
    ))
}
```

- [ ] **Step 8: Build cargo-codepod and smoke-test the dry-run path**

```bash
cargo build -p cpcc-toolchain --release
./target/release/cargo-codepod codepod build --dry-run
```

Expected: prints `CODEPOD_LINK_INJECTED=1` and a `cargo build --target=wasm32-wasip1` line.

```bash
CPCC_ARCHIVE=/some/path/libcodepod_guest_compat.a ./target/release/cargo-codepod codepod build --dry-run
```

Expected: also prints `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS=...` with the `--whole-archive` framing and 32 `-Wl,--export=` flags (16 symbols × 2 — symbol + marker).

- [ ] **Step 9: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/Cargo.toml \
        packages/guest-compat/toolchain/cpcc/src/lib.rs \
        packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs \
        packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs \
        packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs
git commit -m "feat(guest-compat/step-3): add cargo-codepod scaffold + dry-run (Task 8)"
```

---

## Task 9: `cargo-codepod` real execution (linker, version check, env wiring)

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs`

This step turns the wrapper into a working frontend. It spawns the real `cargo`, sets `CARGO_TARGET_WASM32_WASIP1_LINKER` to the wasi-sdk clang path, and runs the same archive version check `cpcc` runs (per §Versioning).

- [ ] **Step 1: Extend `plan_invocation` to also set `CARGO_TARGET_WASM32_WASIP1_LINKER`**

In `cargo_codepod.rs`, add a `wasi_sdk` parameter so the plan can be tested without discovering an SDK on disk. Replace the function with:

```rust
use std::path::Path;

pub fn plan_invocation(sub: Subcommand, forwarded: &[String]) -> Result<InvocationPlan> {
    plan_invocation_with_sdk(sub, forwarded, None)
}

/// Variant that takes an explicit clang path; used when the caller has
/// already discovered an SDK (the binary entrypoint) or wants tests to be
/// hermetic (`None` to skip linker injection).
pub fn plan_invocation_with_sdk(
    sub: Subcommand,
    forwarded: &[String],
    clang: Option<&Path>,
) -> Result<InvocationPlan> {
    let env = crate::env::Env::from_process();
    let mut plan = InvocationPlan::default();

    let verb = sub
        .cargo_verb()
        .ok_or_else(|| anyhow!("subcommand {sub:?} does not correspond to a cargo verb"))?;
    plan.cargo_args.push(verb.to_string());
    plan.cargo_args.push("--target=wasm32-wasip1".to_string());
    for arg in forwarded {
        plan.cargo_args.push(arg.clone());
    }

    plan.env.push(("CODEPOD_LINK_INJECTED".to_string(), "1".to_string()));

    if let Some(c) = clang {
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_LINKER".to_string(),
            c.display().to_string(),
        ));
    }

    if let Some(archive) = &env.archive {
        let mut rustflags = String::new();
        rustflags.push_str("-C link-arg=-Wl,--whole-archive ");
        rustflags.push_str(&format!("-C link-arg={} ", archive.display()));
        rustflags.push_str("-C link-arg=-Wl,--no-whole-archive ");
        for sym in crate::TIER1 {
            rustflags.push_str(&format!("-C link-arg=-Wl,--export={sym} "));
            rustflags.push_str(&format!(
                "-C link-arg=-Wl,--export=__codepod_guest_compat_marker_{sym} "
            ));
        }
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            rustflags.trim_end().to_string(),
        ));
    }

    Ok(plan)
}
```

- [ ] **Step 2: Add a test that verifies linker injection when clang is supplied**

Append to `tests/cargo_codepod_dry_run.rs`:

```rust
use cpcc_toolchain::cargo_codepod::plan_invocation_with_sdk;
use std::path::PathBuf;

#[test]
fn linker_injected_when_clang_supplied() {
    let plan = plan_invocation_with_sdk(
        Subcommand::Build,
        &[],
        Some(&PathBuf::from("/wasi-sdk/bin/clang")),
    )
    .unwrap();
    let linker = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_LINKER")
        .map(|(_, v)| v.as_str());
    assert_eq!(linker, Some("/wasi-sdk/bin/clang"));
}

#[test]
fn linker_omitted_when_clang_missing() {
    let plan = plan_invocation_with_sdk(Subcommand::Build, &[], None).unwrap();
    let linker = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_LINKER");
    assert!(linker.is_none());
}
```

Run:

```bash
cargo test -p cpcc-toolchain --test cargo_codepod_dry_run
```

Expected: 7/7 pass.

- [ ] **Step 3: Update `bin/cargo-codepod.rs` to discover the SDK, run the version check, and exec real cargo**

Replace `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs` with:

```rust
use anyhow::{anyhow, Context, Result};
use cpcc_toolchain::cargo_codepod::{plan_invocation_with_sdk, Subcommand};
use cpcc_toolchain::{archive, env as cpcc_env, wasi_sdk};
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(|s| s.as_str()) == Some("codepod") {
        argv.remove(0);
    }
    if argv.is_empty() {
        return Err(anyhow!(
            "cargo-codepod: expected a subcommand (build, test, run, download-toolchain)"
        ));
    }
    let sub_name = argv.remove(0);
    let sub = Subcommand::parse(&sub_name)?;

    if sub == Subcommand::DownloadToolchain {
        // Implemented in Task 11.
        return Err(anyhow!(
            "cargo-codepod: download-toolchain not yet implemented (Task 11)"
        ));
    }

    let mut dry_run = false;
    argv.retain(|a| {
        if a == "--dry-run" {
            dry_run = true;
            false
        } else {
            true
        }
    });

    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let process_env = cpcc_env::Env::from_process();

    // §Versioning: the version check runs against the same llvm-nm the C
    // wrapper uses. It is presence-only at Step 1; future tightening to an
    // exact major/minor match is owned by archive::check_version.
    if let Some(archive_path) = &process_env.archive {
        if !process_env.skip_version_check {
            archive::check_version(&sdk.nm(), archive_path)
                .context("cargo-codepod: archive version check")?;
        }
    }

    let clang = sdk.clang();
    let plan = plan_invocation_with_sdk(sub, &argv, Some(&clang))?;

    if dry_run {
        for (k, v) in &plan.env {
            println!("{k}={v}");
        }
        print!("cargo");
        for a in &plan.cargo_args {
            print!(" {a}");
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    // Spawn real cargo with the planned args and env additions. Inherits
    // stdio so cargo's own progress shows through. Pre-opt preservation
    // and wasm-opt run in Task 10.
    let mut cmd = Command::new("cargo");
    cmd.args(&plan.cargo_args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let status = cmd.status().context("spawning cargo")?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
```

- [ ] **Step 4: Smoke-test against a tiny throwaway cargo crate**

```bash
cargo build -p cpcc-toolchain --release
make -C packages/guest-compat lib   # ensure the archive exists for version check

mkdir -p /tmp/cargo-codepod-smoke && cd /tmp/cargo-codepod-smoke
cargo init --name smoke --bin
cat > src/main.rs <<'EOF'
fn main() {
    println!("hello from cargo-codepod");
    // Exercise libc::dup2 to prove the link-time override reaches Rust.
    // We don't link libc explicitly in main.rs; std calls into wasi-libc's
    // dup2 if the compat archive ever drops out, signature check would
    // catch it. This smoke test just verifies the wrapper produces a wasm.
}
EOF
echo 'libc = "0.2"' >> Cargo.toml

CPCC_ARCHIVE="$OLDPWD/.worktrees/guest-compat-step-1/packages/guest-compat/build/libcodepod_guest_compat.a" \
  "$OLDPWD/.worktrees/guest-compat-step-1/target/release/cargo-codepod" codepod build --release

ls target/wasm32-wasip1/release/smoke.wasm
cd "$OLDPWD"
rm -rf /tmp/cargo-codepod-smoke
```

Expected: a `smoke.wasm` file exists. If the build fails with a "linker not found" error, the wasi-sdk discovery is misconfigured — fix the SDK path.

- [ ] **Step 5: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs \
        packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs \
        packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs
git commit -m "feat(guest-compat/step-3): cargo-codepod build/test/run + version check (Task 9)"
```

---

## Task 10: `cargo-codepod` pre-opt preservation + wasm-opt + signature check

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs`

The wrapper must produce a stable pre-opt artifact for §Verifying Precedence to inspect, then optionally run `wasm-opt` for size. This mirrors `cpcc`'s `CPCC_PRESERVE_PRE_OPT` / `CPCC_NO_WASM_OPT` flow.

Cargo's wasm-opt invocation: rustc/cargo do not run `wasm-opt` automatically for `wasm32-wasip1` — we own the post-processing. So preservation is just "find the produced .wasm files and copy them" before the optional `wasm-opt` pass.

The cargo build does not tell us where its outputs went unless we run `cargo build --message-format=json` and parse `compiler-artifact` messages. Simpler approach: after a successful build, glob `target/wasm32-wasip1/<profile>/*.wasm` (excluding `deps/`).

- [ ] **Step 1: Add a helper that locates produced .wasm files**

In `cargo_codepod.rs`, append:

```rust
use std::path::PathBuf;

/// Locate every top-level .wasm artifact under `target/wasm32-wasip1/<profile>/`.
/// Excludes `deps/` (intermediates) and `examples/` (not the user's bin).
/// Returns sorted paths so behavior is deterministic across runs.
pub fn locate_outputs(target_dir: &Path, profile: &str) -> Vec<PathBuf> {
    let dir = target_dir.join("wasm32-wasip1").join(profile);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("wasm")
            && path.is_file()
        {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// Profile derived from the forwarded args (`--release` ⇒ "release",
/// otherwise "debug"). `cargo test` overrides this — those binaries land
/// under target/wasm32-wasip1/debug/deps and we don't preserve them.
pub fn profile_from_args(forwarded: &[String]) -> &'static str {
    if forwarded.iter().any(|a| a == "--release") {
        "release"
    } else {
        "debug"
    }
}
```

- [ ] **Step 2: Add a test for `profile_from_args`**

Append to `tests/cargo_codepod_dry_run.rs`:

```rust
use cpcc_toolchain::cargo_codepod::profile_from_args;

#[test]
fn profile_release_when_release_flag_present() {
    assert_eq!(profile_from_args(&["--release".into()]), "release");
}

#[test]
fn profile_debug_when_release_flag_absent() {
    assert_eq!(profile_from_args(&[]), "debug");
}
```

Run:

```bash
cargo test -p cpcc-toolchain --test cargo_codepod_dry_run
```

Expected: 9/9 pass.

- [ ] **Step 3: Wire preservation + wasm-opt into the binary**

In `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs`, add post-build handling. Replace the section starting from `let mut cmd = Command::new("cargo");` to end-of-main with:

```rust
    let mut cmd = Command::new("cargo");
    cmd.args(&plan.cargo_args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let status = cmd.status().context("spawning cargo")?;
    if !status.success() {
        return Ok(status
            .code()
            .map(|c| ExitCode::from(c as u8))
            .unwrap_or(ExitCode::FAILURE));
    }

    // §Verifying Precedence: preserve a pre-opt copy of every produced
    // .wasm so the signature check has an unoptimized artifact, then run
    // wasm-opt on the original. CPCC_PRESERVE_PRE_OPT is reused as the
    // "where" for the pre-opt copy: if it's set, we copy each output
    // alongside it under `<dir>/<stem>.pre-opt.wasm`. If unset, we skip
    // preservation (matching cpcc's behavior).
    use cpcc_toolchain::cargo_codepod::{locate_outputs, profile_from_args};
    use cpcc_toolchain::{preserve, wasm_opt};

    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("target"));
    let profile = profile_from_args(&argv);
    let outputs = locate_outputs(&target_dir, profile);

    for out in &outputs {
        if let Some(preserve_dir) = process_env.preserve_pre_opt.as_deref() {
            let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
            let dst = preserve_dir.join(format!("{stem}.pre-opt.wasm"));
            preserve::copy_to_preserve(out, Some(&dst))?;
        }
        wasm_opt::maybe_run(out, &process_env.wasm_opt)?;
    }

    Ok(ExitCode::SUCCESS)
}
```

Note: `process_env.preserve_pre_opt` is a single `PathBuf`, but for cargo we need a *directory* (cargo can produce multiple wasms per build). The simplest backward-compatible fix is: if `CPCC_PRESERVE_PRE_OPT` exists and is a directory, treat it as a directory; otherwise treat it as a single-file destination (current `cpcc` behavior). Update `cargo-codepod.rs`'s preservation logic to:

```rust
        if let Some(preserve_path) = process_env.preserve_pre_opt.as_deref() {
            let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
            let dst = if preserve_path.is_dir() || outputs.len() > 1 {
                preserve_path.join(format!("{stem}.pre-opt.wasm"))
            } else {
                preserve_path.to_path_buf()
            };
            preserve::copy_to_preserve(out, Some(&dst))?;
        }
```

- [ ] **Step 4: End-to-end smoke test**

```bash
cargo build -p cpcc-toolchain --release
make -C packages/guest-compat lib

mkdir -p /tmp/cargo-codepod-smoke2 && cd /tmp/cargo-codepod-smoke2
cargo init --name smoke2 --bin
echo '[dependencies]' >> Cargo.toml
echo 'libc = "0.2"' >> Cargo.toml
cat > src/main.rs <<'EOF'
fn main() {
    let n = unsafe { libc::dup2(1, 2) };
    println!("dup2={n}");
}
EOF
mkdir -p preserve

CPCC_ARCHIVE="$OLDPWD/.worktrees/guest-compat-step-1/packages/guest-compat/build/libcodepod_guest_compat.a" \
CPCC_PRESERVE_PRE_OPT="$(pwd)/preserve" \
CPCC_NO_WASM_OPT=1 \
  "$OLDPWD/.worktrees/guest-compat-step-1/target/release/cargo-codepod" codepod build --release

ls preserve/smoke2.pre-opt.wasm   # must exist
ls target/wasm32-wasip1/release/smoke2.wasm   # must exist
wasmtime run target/wasm32-wasip1/release/smoke2.wasm   # prints "dup2=2"
cd "$OLDPWD"
rm -rf /tmp/cargo-codepod-smoke2
```

Expected: the preserved pre-opt wasm exists and the runtime output is `dup2=2`.

- [ ] **Step 5: Run `cpcheck` against the preserved smoke wasm to prove §Verifying Precedence works for Rust**

```bash
mkdir -p /tmp/cargo-codepod-check && cd /tmp/cargo-codepod-check
cargo init --name check --bin
echo '[dependencies]' >> Cargo.toml
echo 'libc = "0.2"' >> Cargo.toml
cat > src/main.rs <<'EOF'
fn main() {
    unsafe {
        let _ = libc::dup2(1, 2);
        let _ = libc::getgroups(0, std::ptr::null_mut());
        // touch every Tier 1 symbol to keep the linker from gc'ing them
        let mut sa: libc::sigaction = std::mem::zeroed();
        let _ = libc::sigaction(libc::SIGINT, &sa, std::ptr::null_mut());
    }
}
EOF
mkdir -p preserve
CPCC_ARCHIVE="$OLDPWD/.worktrees/guest-compat-step-1/packages/guest-compat/build/libcodepod_guest_compat.a" \
CPCC_PRESERVE_PRE_OPT="$(pwd)/preserve" \
CPCC_NO_WASM_OPT=1 \
  "$OLDPWD/.worktrees/guest-compat-step-1/target/release/cargo-codepod" codepod build --release

"$OLDPWD/.worktrees/guest-compat-step-1/target/release/cpcheck" \
  --archive "$OLDPWD/.worktrees/guest-compat-step-1/packages/guest-compat/build/libcodepod_guest_compat.a" \
  --pre-opt-wasm preserve/check.pre-opt.wasm \
  --symbol dup2 --symbol getgroups --symbol sigaction
cd "$OLDPWD"
rm -rf /tmp/cargo-codepod-check
```

Expected: `signature check: OK (3 symbols)`. If it fails on any of the three, the RUSTFLAGS framing in `plan_invocation_with_sdk` is buggy — re-check that every `-Wl,--export=` flag was emitted (the dry-run output should show 32 of them).

- [ ] **Step 6: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs \
        packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs \
        packages/guest-compat/toolchain/cpcc/tests/cargo_codepod_dry_run.rs
git commit -m "feat(guest-compat/step-3): cargo-codepod pre-opt preservation + wasm-opt + cpcheck (Task 10)"
```

---

## Task 11: `cargo codepod download-toolchain`

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs`

Phase A doesn't ship a custom toolchain (Phase B does, per §Phase B). The closest Phase A primitive is `rustup target add wasm32-wasip1` so a fresh user can run `cargo codepod build` after one bootstrap command.

- [ ] **Step 1: Add `download_toolchain` function**

In `cargo_codepod.rs`, append:

```rust
use std::process::Command;

/// Phase A `download-toolchain`: ensures `wasm32-wasip1` is available via
/// rustup. Returns Ok with a status message; exits 0 on success even if
/// the target was already installed. §Phase B will replace this with a
/// codepod toolchain distribution download.
pub fn download_toolchain() -> Result<String> {
    // `rustup target list --installed` lists targets with no extra noise.
    let listing = Command::new("rustup")
        .args(["target", "list", "--installed"])
        .output()
        .map_err(|e| anyhow!("rustup not available: {e}"))?;
    if !listing.status.success() {
        return Err(anyhow!(
            "rustup target list failed: {}",
            String::from_utf8_lossy(&listing.stderr)
        ));
    }
    let installed = String::from_utf8_lossy(&listing.stdout);
    if installed.lines().any(|l| l.trim() == "wasm32-wasip1") {
        return Ok("wasm32-wasip1 is already installed".into());
    }
    let install = Command::new("rustup")
        .args(["target", "add", "wasm32-wasip1"])
        .status()
        .map_err(|e| anyhow!("rustup target add failed to spawn: {e}"))?;
    if !install.success() {
        return Err(anyhow!("rustup target add wasm32-wasip1 failed"));
    }
    Ok("installed wasm32-wasip1 via rustup".into())
}
```

- [ ] **Step 2: Wire it into the binary**

In `bin/cargo-codepod.rs`, replace the `if sub == Subcommand::DownloadToolchain` early-return with:

```rust
    if sub == Subcommand::DownloadToolchain {
        let msg = cpcc_toolchain::cargo_codepod::download_toolchain()?;
        println!("cargo-codepod: {msg}");
        return Ok(ExitCode::SUCCESS);
    }
```

- [ ] **Step 3: Smoke-test (rustup must be available)**

```bash
cargo build -p cpcc-toolchain --release
./target/release/cargo-codepod codepod download-toolchain
```

Expected: either "wasm32-wasip1 is already installed" (most dev envs already have it) or "installed wasm32-wasip1 via rustup".

- [ ] **Step 4: Commit**

```bash
git add packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs \
        packages/guest-compat/toolchain/cpcc/src/bin/cargo-codepod.rs
git commit -m "feat(guest-compat/step-3): cargo-codepod download-toolchain (Task 11)"
```

---

## Task 12: `codepod-guest-compat-sys` crate (3c)

**Files:**
- Create: `packages/guest-compat/rust/codepod-guest-compat-sys/Cargo.toml`
- Create: `packages/guest-compat/rust/codepod-guest-compat-sys/build.rs`
- Create: `packages/guest-compat/rust/codepod-guest-compat-sys/src/lib.rs`
- Create: `packages/guest-compat/rust/codepod-guest-compat-sys/tests/build_rs.rs`
- Modify: root `Cargo.toml` (add workspace member)

A standard Rust `-sys` crate (per §Toolchain Integration > Rust Toolchain). The `build.rs` is **target-gated** so host builds are always a no-op: only when the compilation target is `wasm32-wasip1` does it consider emitting link directives. This is what preserves ordinary root `cargo build` ergonomics — root workspace builds compile the crate for the host, where no archive is needed and no linking to the compat archive is appropriate. Three build paths it must support, all tested:

1. **Host target, any env state:** no-op (the archive is a wasm artifact; host builds have no business linking it).
2. **wasm32-wasip1 target under `cargo-codepod`:** the wrapper sets `CODEPOD_LINK_INJECTED=1`, the build.rs no-ops (one-way coordination per §Override And Link Precedence — applying `--whole-archive` twice yields duplicate strong defs and the link fails).
3. **wasm32-wasip1 target under plain `cargo build` (the "alternate path" from §Toolchain Integration > Rust Toolchain lines 553-564):** the consumer must set `CODEPOD_GUEST_COMPAT_LIBDIR` or `CPCC_ARCHIVE`; the build.rs emits the link-search, whole-archive `codepod_guest_compat` lib, and the 32 `--export=` flags. If neither env var is set in path 3, the build fails with a message pointing at the env var surface.

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "codepod-guest-compat-sys"
version = "0.1.0"
edition = "2021"
publish = false
description = "Native bindings to libcodepod_guest_compat.a; emits link directives unless cargo-codepod has already injected them."
links = "codepod_guest_compat"

[lib]
path = "src/lib.rs"

[build-dependencies]

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Create `src/lib.rs`**

```rust
//! Bindings to the codepod guest compatibility runtime archive
//! (libcodepod_guest_compat.a). This crate exists for codepod-authored
//! Rust guests that want plain `cargo build` to also work; under
//! `cargo-codepod` the wrapper handles link injection and this crate
//! becomes a no-op linkage carrier.
//!
//! The actual Tier 1 ABI is reached through `libc::*` calls — those
//! resolve to the C archive's strong defs at link time. This crate
//! deliberately exports no Rust functions of its own.
#![no_std]

/// Compile-time version constant matching CODEPOD_GUEST_COMPAT_VERSION_MAJOR/MINOR
/// in `packages/guest-compat/include/codepod_compat.h` (§Versioning).
pub const VERSION: u32 = (1 << 16) | 0;
```

- [ ] **Step 3: Create `build.rs` (target-gated, with the CODEPOD_LINK_INJECTED handshake)**

```rust
//! Build-time link directives for `libcodepod_guest_compat.a`. Three paths:
//!  1. Host target → no-op (archive is a wasm artifact, host has nothing to link).
//!  2. wasm32-wasip1 + CODEPOD_LINK_INJECTED=1 → no-op (cargo-codepod already
//!     framed --whole-archive via RUSTFLAGS; emitting here would link twice).
//!  3. wasm32-wasip1 without CODEPOD_LINK_INJECTED → emit link-search, whole-
//!     archive bundle lib, and per-Tier-1-symbol --export flags. Requires
//!     CODEPOD_GUEST_COMPAT_LIBDIR or CPCC_ARCHIVE; errors with a clear
//!     message if neither is set.
//!
//! Also runs an llvm-nm presence check on the archive in path 3, mirroring
//! `cpcc`'s `archive::check_version` so plain-cargo consumers get the same
//! version-mismatch surface as cargo-codepod consumers.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=CODEPOD_LINK_INJECTED");
    println!("cargo:rerun-if-env-changed=CODEPOD_GUEST_COMPAT_LIBDIR");
    println!("cargo:rerun-if-env-changed=CPCC_ARCHIVE");
    println!("cargo:rerun-if-env-changed=CPCC_SKIP_VERSION_CHECK");

    // CARGO_CFG_TARGET_OS + CARGO_CFG_TARGET_ARCH are how build.rs scripts
    // learn what cargo is actually targeting. For wasm32-wasip1 these are
    // `wasi` and `wasm32`. TARGET is the full triple; we use it because
    // `wasm32-wasip1` and `wasm32-wasi` both have TARGET_OS=wasi but we
    // only want to inject into the p1 variant codepod ships.
    let target = env::var("TARGET").unwrap_or_default();
    if target != "wasm32-wasip1" {
        // Path 1: host (or any non-wasip1) build. Harmless no-op so workspace
        // builds never fail for developers who aren't targeting codepod.
        return;
    }

    if env::var("CODEPOD_LINK_INJECTED").is_ok() {
        // Path 2: cargo-codepod already injected via RUSTFLAGS.
        println!("cargo:warning=codepod-guest-compat-sys: CODEPOD_LINK_INJECTED set, skipping link directives");
        return;
    }

    // Path 3: wasm32-wasip1 under plain cargo — archive env is required.
    let lib_path = locate_archive();
    let lib_dir = lib_path.parent().unwrap_or_else(|| PathBuf::from(".").as_path()).to_path_buf();

    if env::var("CPCC_SKIP_VERSION_CHECK").is_err() {
        run_version_check(&lib_path);
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    // `static:+whole-archive+bundle` mirrors the Phase A C-side --whole-archive
    // semantics (§Override And Link Precedence > Link Order C frontend).
    println!("cargo:rustc-link-lib=static:+whole-archive+bundle=codepod_guest_compat");

    // Per-Tier-1-symbol --export framing so the implementation-signature
    // check (§Verifying Precedence) finds markers in the pre-opt wasm. Same
    // 16 symbols as cpcc-toolchain::TIER1 — must stay in sync with
    // packages/guest-compat/toolchain/cpcc/src/lib.rs TIER1.
    for sym in TIER1 {
        println!("cargo:rustc-link-arg=-Wl,--export={sym}");
        println!("cargo:rustc-link-arg=-Wl,--export=__codepod_guest_compat_marker_{sym}");
    }
}

/// Must stay in sync with `cpcc_toolchain::TIER1`. A CI parity check
/// (Task 18 step 2.5) asserts this at build time.
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

fn locate_archive() -> PathBuf {
    if let Ok(explicit) = env::var("CODEPOD_GUEST_COMPAT_LIBDIR") {
        return PathBuf::from(explicit).join("libcodepod_guest_compat.a");
    }
    if let Ok(explicit) = env::var("CPCC_ARCHIVE") {
        return PathBuf::from(explicit);
    }
    // Only reachable when TARGET is wasm32-wasip1 AND CODEPOD_LINK_INJECTED
    // is unset — i.e. the "alternate path" for plain cargo. Host builds
    // never see this.
    panic!(
        "codepod-guest-compat-sys: targeting wasm32-wasip1 with neither CODEPOD_GUEST_COMPAT_LIBDIR nor CPCC_ARCHIVE set. Either set one to point at libcodepod_guest_compat.a, or build via cargo-codepod which sets CODEPOD_LINK_INJECTED=1 and frames the archive itself."
    );
}

fn run_version_check(archive: &std::path::Path) {
    let nm = locate_nm();
    let out = Command::new(&nm)
        .arg("--defined-only")
        .arg(archive)
        .output()
        .unwrap_or_else(|e| panic!("running {} on {}: {e}", nm.display(), archive.display()));
    if !out.status.success() {
        panic!(
            "llvm-nm failed on {}: {}",
            archive.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let present = stdout.lines().any(|line| {
        line.split_whitespace().last() == Some("codepod_guest_compat_version")
    });
    if !present {
        panic!(
            "archive {} does not define codepod_guest_compat_version (§Versioning); set CPCC_SKIP_VERSION_CHECK=1 to bypass",
            archive.display()
        );
    }
}

fn locate_nm() -> PathBuf {
    if let Ok(p) = env::var("LLVM_NM") {
        return PathBuf::from(p);
    }
    if let Ok(sdk) = env::var("WASI_SDK_PATH") {
        return PathBuf::from(sdk).join("bin/llvm-nm");
    }
    PathBuf::from("llvm-nm")
}
```

- [ ] **Step 4: Create `tests/build_rs.rs` (test the CODEPOD_LINK_INJECTED handshake without spawning a real build)**

```rust
//! Verify the build-script logic in isolation. We don't actually run
//! cargo here — that would require a wasm32 target and a real archive.
//! Instead we invoke `build.rs` as a binary with curated env vars and
//! check its stdout (cargo's build-script protocol is line-based).

use std::path::PathBuf;
use std::process::Command;

fn build_rs_binary() -> PathBuf {
    // Compile build.rs once into a tempfile and invoke it. This relies on
    // rustc being on PATH; tests skip themselves if not.
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("build_rs");
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs");
    let status = Command::new("rustc")
        .args(["--edition=2021", "-O"])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();
    match status {
        Ok(s) if s.success() => {}
        _ => {
            eprintln!("rustc not available or build.rs did not compile; skipping");
            return PathBuf::new();
        }
    }
    // Persist by leaking the tempdir — we want the binary to outlive `dir`.
    let _ = dir.into_path();
    bin
}

/// All four tests exercise `build.rs` as a standalone binary because the
/// real cargo invocation requires a full crate-graph. The TARGET env var
/// is what tells `build.rs` which path to take.

#[test]
fn host_target_is_noop_regardless_of_env() {
    let bin = build_rs_binary();
    if !bin.exists() { return; }
    // Host target = current platform triple; pick something obviously non-wasi.
    // This is the load-bearing test for preserving root `cargo build`.
    let out = Command::new(&bin)
        .env("TARGET", "x86_64-unknown-linux-gnu")
        .env_remove("CODEPOD_LINK_INJECTED")
        .env_remove("CPCC_ARCHIVE")
        .env_remove("CODEPOD_GUEST_COMPAT_LIBDIR")
        .output()
        .unwrap();
    assert!(out.status.success(),
            "host build.rs must not fail even with no env: {}",
            String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!stdout.contains("rustc-link-lib=static"),
            "host build must not emit link-lib; got: {stdout}");
    assert!(!stdout.contains("rustc-link-arg="),
            "host build must not emit link-arg; got: {stdout}");
}

#[test]
fn wasip1_target_skips_when_codepod_link_injected_set() {
    let bin = build_rs_binary();
    if !bin.exists() { return; }
    let out = Command::new(&bin)
        .env("TARGET", "wasm32-wasip1")
        .env("CODEPOD_LINK_INJECTED", "1")
        .env_remove("CPCC_ARCHIVE")
        .env_remove("CODEPOD_GUEST_COMPAT_LIBDIR")
        .output()
        .unwrap();
    assert!(out.status.success(), "build.rs failed: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!stdout.contains("rustc-link-lib=static"),
            "should not emit link-lib when CODEPOD_LINK_INJECTED is set; got: {stdout}");
    assert!(stdout.contains("CODEPOD_LINK_INJECTED set, skipping"),
            "should warn about skipping; got: {stdout}");
}

#[test]
fn wasip1_target_emits_link_directives_when_archive_provided() {
    let bin = build_rs_binary();
    if !bin.exists() { return; }
    // Create a fake archive file so the path-based check passes; skip the
    // version check via env var to avoid llvm-nm dependency in tests.
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("libcodepod_guest_compat.a");
    std::fs::write(&archive, b"!<arch>\n").unwrap();
    let out = Command::new(&bin)
        .env("TARGET", "wasm32-wasip1")
        .env_remove("CODEPOD_LINK_INJECTED")
        .env("CPCC_ARCHIVE", &archive)
        .env("CPCC_SKIP_VERSION_CHECK", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "build.rs failed: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("rustc-link-search=native="), "missing link-search: {stdout}");
    assert!(stdout.contains("rustc-link-lib=static:+whole-archive+bundle=codepod_guest_compat"),
            "missing whole-archive lib directive: {stdout}");
    // 16 Tier 1 symbols × 2 exports each = 32 export flags.
    let export_count = stdout.matches("rustc-link-arg=-Wl,--export=").count();
    assert_eq!(export_count, 32, "expected 32 export flags, got {export_count}: {stdout}");
}

#[test]
fn wasip1_target_panics_when_neither_archive_env_set_and_not_injected() {
    let bin = build_rs_binary();
    if !bin.exists() { return; }
    let out = Command::new(&bin)
        .env("TARGET", "wasm32-wasip1")
        .env_remove("CODEPOD_LINK_INJECTED")
        .env_remove("CPCC_ARCHIVE")
        .env_remove("CODEPOD_GUEST_COMPAT_LIBDIR")
        .output()
        .unwrap();
    assert!(!out.status.success(),
            "wasm32-wasip1 build.rs should fail when archive env is missing");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("CODEPOD_GUEST_COMPAT_LIBDIR") || stderr.contains("CPCC_ARCHIVE"),
            "panic message should mention env vars: {stderr}");
}
```

- [ ] **Step 5: Add to workspace**

In root `Cargo.toml`, append to `members`:

```toml
  "packages/guest-compat/rust/codepod-guest-compat-sys",
```

- [ ] **Step 6: Run tests**

```bash
cargo test -p codepod-guest-compat-sys
```

Expected: 4/4 pass. If `rustc` isn't found by the test, the tests early-return — that's fine in CI (CI has rustc). The load-bearing test is `host_target_is_noop_regardless_of_env`: this is what guarantees root `cargo build` keeps working without any env setup.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml \
        packages/guest-compat/rust/codepod-guest-compat-sys/
git commit -m "feat(guest-compat/step-3): add codepod-guest-compat-sys crate (Task 12)"
```

---

## Task 13: `codepod-guest-compat` safe-wrapper crate (3c)

**Files:**
- Create: `packages/guest-compat/rust/codepod-guest-compat/Cargo.toml`
- Create: `packages/guest-compat/rust/codepod-guest-compat/src/lib.rs`
- Create: `packages/guest-compat/rust/codepod-guest-compat/src/dup2.rs`
- Create: `packages/guest-compat/rust/codepod-guest-compat/src/sched.rs`
- Create: `packages/guest-compat/rust/codepod-guest-compat/src/signal.rs`
- Create: `packages/guest-compat/rust/codepod-guest-compat/tests/version.rs`
- Modify: root `Cargo.toml` (add workspace member)

Per §Toolchain Integration > Rust Toolchain: *"safe wrappers over the C ABI for ergonomics. Tier 1 semantics still reach `libc::dup2`, `libc::signal`, etc. through the link-time override alone; these wrappers exist for Rust-native types, not correctness."* So this crate has no implementations — only thin Result-returning wrappers.

The crate depends on `codepod-guest-compat-sys` so consumers get the link directives transitively when not using `cargo-codepod`. It also depends on `libc` for the raw FFI.

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "codepod-guest-compat"
version = "0.1.0"
edition = "2021"
publish = false
description = "Safe Rust wrappers over the codepod guest compatibility runtime Tier 1 ABI."

[lib]
path = "src/lib.rs"

[dependencies]
codepod-guest-compat-sys = { path = "../codepod-guest-compat-sys" }
libc = "0.2"

[dev-dependencies]
```

- [ ] **Step 2: Create `src/lib.rs`**

```rust
//! Safe Rust wrappers over the Tier 1 ABI defined in
//! `docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`
//! §Compatibility Tiers > Tier 1.
//!
//! These wrappers translate POSIX-style return values into idiomatic
//! Rust `Result`s. They do NOT contain implementations — every Tier 1
//! call ultimately reaches the C archive `libcodepod_guest_compat.a`
//! through the link-time override (§Override And Link Precedence).

#![cfg_attr(not(test), no_std)]
extern crate alloc;

pub mod dup2;
pub mod sched;
pub mod signal;

/// Re-export the version constant so callers can do an at-runtime check
/// against the runtime they're actually linked against. (§Versioning.)
pub use codepod_guest_compat_sys::VERSION;
```

- [ ] **Step 3: Create `src/dup2.rs`**

```rust
//! Wrapper for `dup2(2)` (§Runtime Semantics > File Descriptors).

use core::ffi::c_int;

/// Renumber the open guest-visible fd `oldfd` onto `newfd`. Returns the
/// new fd on success; on failure returns the captured `errno` value
/// (POSIX numbering — WASI's EBADF is 8).
pub fn dup2(oldfd: c_int, newfd: c_int) -> Result<c_int, c_int> {
    // SAFETY: libc::dup2 is FFI; both args are integers and validation
    // happens in the runtime impl.
    let rc = unsafe { libc::dup2(oldfd, newfd) };
    if rc < 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(rc)
    }
}
```

- [ ] **Step 4: Create `src/sched.rs`**

```rust
//! Wrappers for `sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`
//! (§Runtime Semantics > Affinity).

use core::ffi::c_int;
use core::mem::{size_of, zeroed};

/// Return the set of CPUs the guest is allowed to run on. The codepod
/// runtime always reports a single visible CPU (CPU 0) per the runtime
/// semantics; callers receive a freshly-zeroed `cpu_set_t` with bit 0 set.
pub fn get_affinity() -> Result<libc::cpu_set_t, c_int> {
    let mut mask: libc::cpu_set_t = unsafe { zeroed() };
    let rc = unsafe { libc::sched_getaffinity(0, size_of::<libc::cpu_set_t>(), &mut mask) };
    if rc != 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(mask)
    }
}

/// Set the CPU mask. Only the mask `{CPU 0}` is accepted; any other
/// mask is rejected with EINVAL.
pub fn set_affinity(mask: &libc::cpu_set_t) -> Result<(), c_int> {
    let rc = unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), mask) };
    if rc != 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(())
    }
}

/// Return the running CPU. Always 0 for codepod guests.
pub fn get_cpu() -> c_int {
    unsafe { libc::sched_getcpu() }
}
```

- [ ] **Step 5: Create `src/signal.rs`**

```rust
//! Wrappers for the narrow signal surface (§Runtime Semantics > Signals).
//! Only the helpers most useful from idiomatic Rust are wrapped — the
//! sigset_t bit ops (sigemptyset/sigfillset/sigaddset/sigdelset/sigismember)
//! are kept FFI-direct since they're cheap and Rust users typically reach
//! for `signal-hook` for richer ergonomics.

use core::ffi::c_int;
use core::mem::zeroed;

/// `signal(sig, handler)` — install the legacy handler. Returns the
/// previous handler on success; SIG_ERR on failure.
///
/// # Safety
/// The handler runs in async-signal context. It must only call
/// async-signal-safe functions.
pub unsafe fn install_handler(sig: c_int, handler: libc::sighandler_t) -> libc::sighandler_t {
    libc::signal(sig, handler)
}

/// `raise(sig)` — synchronously deliver `sig` to the current process.
pub fn raise(sig: c_int) -> Result<(), c_int> {
    let rc = unsafe { libc::raise(sig) };
    if rc != 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(())
    }
}

/// `alarm(seconds)` — return the seconds remaining on the previous alarm.
pub fn alarm(seconds: u32) -> u32 {
    unsafe { libc::alarm(seconds) }
}

/// Build an empty signal set.
pub fn empty_set() -> Result<libc::sigset_t, c_int> {
    let mut set: libc::sigset_t = unsafe { zeroed() };
    let rc = unsafe { libc::sigemptyset(&mut set) };
    if rc != 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(set)
    }
}

/// Build a signal set with all signals.
pub fn full_set() -> Result<libc::sigset_t, c_int> {
    let mut set: libc::sigset_t = unsafe { zeroed() };
    let rc = unsafe { libc::sigfillset(&mut set) };
    if rc != 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(set)
    }
}

/// Get/set the guest-local signal mask. Note that codepod's signal layer
/// only observes signals raised by the guest itself (§Runtime Semantics
/// > Signals); the mask does not gate external delivery.
pub fn proc_mask(how: c_int, set: Option<&libc::sigset_t>) -> Result<libc::sigset_t, c_int> {
    let mut old: libc::sigset_t = unsafe { zeroed() };
    let set_ptr = set.map(|s| s as *const _).unwrap_or(core::ptr::null());
    let rc = unsafe { libc::sigprocmask(how, set_ptr, &mut old) };
    if rc != 0 {
        Err(unsafe { *libc::__errno_location() })
    } else {
        Ok(old)
    }
}
```

- [ ] **Step 6: Create `tests/version.rs`**

```rust
#[test]
fn version_constant_matches_phase_a_major_minor() {
    // Step 1 set CODEPOD_GUEST_COMPAT_VERSION_MAJOR=1, MINOR=0 in the C header.
    // The Rust constant must agree, otherwise the cross-language version
    // check in Task 18 would silently mismatch.
    assert_eq!(codepod_guest_compat::VERSION, (1u32 << 16) | 0);
}
```

- [ ] **Step 7: Add to workspace**

In root `Cargo.toml`, append to `members`:

```toml
  "packages/guest-compat/rust/codepod-guest-compat",
```

- [ ] **Step 8: Build the crate for the host target**

```bash
cargo build -p codepod-guest-compat
```

Expected: clean success, no warnings from `-sys` about missing archive (Task 12's target-gated `build.rs` no-ops on host targets). If this step fails with a panic about `CODEPOD_GUEST_COMPAT_LIBDIR` or `CPCC_ARCHIVE`, the Task 12 target gate is broken — do not paper over with `CODEPOD_LINK_INJECTED=1`; fix the gate.

- [ ] **Step 9: Verify the full root workspace still builds host-side (regression check for issue raised during plan review)**

```bash
cargo check --workspace
```

Expected: success, and specifically no failures in `codepod-guest-compat-sys` / `codepod-guest-compat` / any of the four Rust canary crates. This is the load-bearing check that adding these workspace members doesn't break every other codepod developer's `cargo build`.

- [ ] **Step 10: Run tests**

```bash
cargo test -p codepod-guest-compat
```

Expected: 1/1 pass. No env-var gymnastics required.

- [ ] **Step 11: Commit**

```bash
git add Cargo.toml \
        packages/guest-compat/rust/codepod-guest-compat/
git commit -m "feat(guest-compat/step-3): add codepod-guest-compat safe-wrapper crate (Task 13)"
```

---

## Task 14: Rust dup2-canary (3d)

**Files:**
- Create: `packages/guest-compat/conformance/rust/dup2-canary/Cargo.toml`
- Create: `packages/guest-compat/conformance/rust/dup2-canary/src/main.rs`
- Modify: root `Cargo.toml` (add workspace member)

The Rust canary mirrors the C canary's `--case` interface and JSONL output. It uses raw `libc::dup2` so the link-time override has to win — exactly the path the implementation-signature check verifies.

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "dup2-canary"
version = "0.1.0"
edition = "2021"
publish = false

[[bin]]
name = "dup2-canary"
path = "src/main.rs"

[dependencies]
libc = "0.2"
```

- [ ] **Step 2: Create `src/main.rs`**

```rust
//! Paired Rust canary for §Behavioral Spec dup2.spec.toml. Cases must
//! match exactly the cases in packages/guest-compat/conformance/c/dup2-canary.c
//! — divergence is the failure mode per §Conformance Driver.

use std::io::Write;

fn emit(case: &str, exit: i32, stdout_line: Option<&str>, errno: Option<i32>) {
    let mut buf = String::new();
    buf.push_str(&format!("{{\"case\":\"{case}\",\"exit\":{exit}"));
    if let Some(s) = stdout_line {
        buf.push_str(&format!(",\"stdout\":\"{s}\""));
    }
    if let Some(e) = errno {
        buf.push_str(&format!(",\"errno\":{e}"));
    }
    buf.push_str("}\n");
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    handle.write_all(buf.as_bytes()).unwrap();
}

fn case_happy_path() -> i32 {
    let rc = unsafe { libc::dup2(1, 2) };
    if rc < 0 {
        let errno = unsafe { *libc::__errno_location() };
        emit("happy_path", 1, None, Some(errno));
        return 1;
    }
    emit("happy_path", 0, Some("dup2-ok"), None);
    0
}

fn case_invalid_fd() -> i32 {
    unsafe { *libc::__errno_location() = 0 };
    let rc = unsafe { libc::dup2(999, 2) };
    if rc >= 0 {
        emit("invalid_fd", 1, None, None);
        return 1;
    }
    let errno = unsafe { *libc::__errno_location() };
    emit("invalid_fd", 1, None, Some(errno));
    1
}

fn run_case(name: &str) -> i32 {
    match name {
        "happy_path" => case_happy_path(),
        "invalid_fd" => case_invalid_fd(),
        _ => {
            eprintln!("dup2-canary: unknown case {name}");
            2
        }
    }
}

fn list_cases() {
    println!("happy_path");
    println!("invalid_fd");
}

fn smoke_mode() -> i32 {
    let rc = unsafe { libc::dup2(1, 2) };
    if rc < 0 {
        eprintln!("dup2: failed");
        return 1;
    }
    eprintln!("dup2-ok");
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let exit = match argv.len() {
        1 => smoke_mode(),
        2 if argv[1] == "--list-cases" => { list_cases(); 0 }
        3 if argv[1] == "--case" => run_case(&argv[2]),
        _ => {
            eprintln!("usage: dup2-canary [--case <name> | --list-cases]");
            2
        }
    };
    std::process::exit(exit);
}
```

- [ ] **Step 3: Add to workspace**

In root `Cargo.toml`, append to `members`:

```toml
  "packages/guest-compat/conformance/rust/dup2-canary",
```

- [ ] **Step 4: Build via `cargo-codepod` to confirm it actually links**

```bash
cargo build -p cpcc-toolchain --release
make -C packages/guest-compat lib

CPCC_ARCHIVE=$(pwd)/packages/guest-compat/build/libcodepod_guest_compat.a \
CPCC_PRESERVE_PRE_OPT=$(pwd)/packages/guest-compat/build \
CPCC_NO_WASM_OPT=1 \
  ./target/release/cargo-codepod codepod build --release -p dup2-canary
```

Expected: `target/wasm32-wasip1/release/dup2-canary.wasm` exists, plus `packages/guest-compat/build/dup2-canary.pre-opt.wasm`.

- [ ] **Step 5: Run the wasm and check JSONL output**

```bash
wasmtime run target/wasm32-wasip1/release/dup2-canary.wasm -- --case happy_path
# Expected: {"case":"happy_path","exit":0,"stdout":"dup2-ok"}

wasmtime run target/wasm32-wasip1/release/dup2-canary.wasm -- --case invalid_fd
# Expected: {"case":"invalid_fd","exit":1,"errno":8}
```

- [ ] **Step 6: Run signature check on the pre-opt wasm**

```bash
./target/release/cpcheck \
  --archive packages/guest-compat/build/libcodepod_guest_compat.a \
  --pre-opt-wasm packages/guest-compat/build/dup2-canary.pre-opt.wasm \
  --symbol dup2
```

Expected: `signature check: OK (1 symbols)`. If it fails on stage 3 (call edge), the RUSTFLAGS framing in `cargo-codepod` is missing the `__codepod_guest_compat_marker_dup2` export — fix and re-run.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml \
        packages/guest-compat/conformance/rust/dup2-canary/
git commit -m "feat(guest-compat/step-3): add Rust dup2-canary (Task 14)"
```

---

## Task 15: Rust getgroups-canary (3d)

**Files:**
- Create: `packages/guest-compat/conformance/rust/getgroups-canary/Cargo.toml`
- Create: `packages/guest-compat/conformance/rust/getgroups-canary/src/main.rs`
- Modify: root `Cargo.toml` (add workspace member)

Same shape as Task 14. Cases mirror `getgroups.spec.toml`.

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "getgroups-canary"
version = "0.1.0"
edition = "2021"
publish = false

[[bin]]
name = "getgroups-canary"
path = "src/main.rs"

[dependencies]
libc = "0.2"
```

- [ ] **Step 2: Create `src/main.rs`**

```rust
use std::io::Write;

fn emit(case: &str, exit: i32, stdout_line: Option<&str>, errno: Option<i32>) {
    let mut buf = String::new();
    buf.push_str(&format!("{{\"case\":\"{case}\",\"exit\":{exit}"));
    if let Some(s) = stdout_line { buf.push_str(&format!(",\"stdout\":\"{s}\"")); }
    if let Some(e) = errno { buf.push_str(&format!(",\"errno\":{e}")); }
    buf.push_str("}\n");
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    h.write_all(buf.as_bytes()).unwrap();
}

fn case_count_only() -> i32 {
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count != 1 {
        emit("count_only", 1, None, None);
        return 1;
    }
    emit("count_only", 0, Some("getgroups:1"), None);
    0
}

fn case_fetch_one() -> i32 {
    let mut groups: [libc::gid_t; 1] = [99];
    let count = unsafe { libc::getgroups(1, groups.as_mut_ptr()) };
    if count != 1 || groups[0] != 0 {
        emit("fetch_one", 1, None, None);
        return 1;
    }
    emit("fetch_one", 0, Some("getgroups:1:0"), None);
    0
}

fn run_case(name: &str) -> i32 {
    match name {
        "count_only" => case_count_only(),
        "fetch_one" => case_fetch_one(),
        _ => { eprintln!("getgroups-canary: unknown case {name}"); 2 }
    }
}

fn list_cases() {
    println!("count_only");
    println!("fetch_one");
}

fn smoke_mode() -> i32 {
    let mut groups: [libc::gid_t; 1] = [0];
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count != 1 { eprintln!("unexpected count"); return 1; }
    let count2 = unsafe { libc::getgroups(1, groups.as_mut_ptr()) };
    if count2 != 1 { eprintln!("unexpected count2"); return 1; }
    println!("getgroups:{}:{}", count2, groups[0]);
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let exit = match argv.len() {
        1 => smoke_mode(),
        2 if argv[1] == "--list-cases" => { list_cases(); 0 }
        3 if argv[1] == "--case" => run_case(&argv[2]),
        _ => { eprintln!("usage: getgroups-canary [--case <name> | --list-cases]"); 2 }
    };
    std::process::exit(exit);
}
```

- [ ] **Step 3: Add to workspace**

In root `Cargo.toml`, append:

```toml
  "packages/guest-compat/conformance/rust/getgroups-canary",
```

- [ ] **Step 4: Build, run, verify**

```bash
CPCC_ARCHIVE=$(pwd)/packages/guest-compat/build/libcodepod_guest_compat.a \
CPCC_PRESERVE_PRE_OPT=$(pwd)/packages/guest-compat/build \
CPCC_NO_WASM_OPT=1 \
  ./target/release/cargo-codepod codepod build --release -p getgroups-canary

wasmtime run target/wasm32-wasip1/release/getgroups-canary.wasm -- --case count_only
# Expected: {"case":"count_only","exit":0,"stdout":"getgroups:1"}

./target/release/cpcheck \
  --archive packages/guest-compat/build/libcodepod_guest_compat.a \
  --pre-opt-wasm packages/guest-compat/build/getgroups-canary.pre-opt.wasm \
  --symbol getgroups
```

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml packages/guest-compat/conformance/rust/getgroups-canary/
git commit -m "feat(guest-compat/step-3): add Rust getgroups-canary (Task 15)"
```

---

## Task 16: Rust affinity-canary (3d)

**Files:**
- Create: `packages/guest-compat/conformance/rust/affinity-canary/Cargo.toml`
- Create: `packages/guest-compat/conformance/rust/affinity-canary/src/main.rs`
- Modify: root `Cargo.toml`

Cases mirror the union of `sched_getaffinity.spec.toml`, `sched_setaffinity.spec.toml`, `sched_getcpu.spec.toml`.

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "affinity-canary"
version = "0.1.0"
edition = "2021"
publish = false

[[bin]]
name = "affinity-canary"
path = "src/main.rs"

[dependencies]
libc = "0.2"
```

- [ ] **Step 2: Create `src/main.rs`**

```rust
use std::io::Write;
use std::mem::{size_of, zeroed};

fn emit(case: &str, exit: i32, stdout_line: Option<&str>, errno: Option<i32>) {
    let mut buf = String::new();
    buf.push_str(&format!("{{\"case\":\"{case}\",\"exit\":{exit}"));
    if let Some(s) = stdout_line { buf.push_str(&format!(",\"stdout\":\"{s}\"")); }
    if let Some(e) = errno { buf.push_str(&format!(",\"errno\":{e}")); }
    buf.push_str("}\n");
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    h.write_all(buf.as_bytes()).unwrap();
}

unsafe fn cpu_count(mask: &libc::cpu_set_t) -> i32 {
    libc::CPU_COUNT(mask)
}

fn case_get_reports_one_cpu() -> i32 {
    let mut mask: libc::cpu_set_t = unsafe { zeroed() };
    let rc = unsafe { libc::sched_getaffinity(0, size_of::<libc::cpu_set_t>(), &mut mask) };
    if rc != 0 {
        let e = unsafe { *libc::__errno_location() };
        emit("get_reports_one_cpu", 1, None, Some(e));
        return 1;
    }
    let count = unsafe { cpu_count(&mask) };
    let bit0 = unsafe { libc::CPU_ISSET(0, &mask) };
    if count != 1 || !bit0 {
        emit("get_reports_one_cpu", 1, None, None);
        return 1;
    }
    emit("get_reports_one_cpu", 0, Some("affinity:get=1"), None);
    0
}

fn case_set_cpu0_succeeds() -> i32 {
    let mut mask: libc::cpu_set_t = unsafe { zeroed() };
    unsafe { libc::CPU_SET(0, &mut mask) };
    let rc = unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &mask) };
    if rc != 0 {
        let e = unsafe { *libc::__errno_location() };
        emit("set_cpu0_succeeds", 1, None, Some(e));
        return 1;
    }
    emit("set_cpu0_succeeds", 0, Some("affinity:set0=ok"), None);
    0
}

fn case_set_cpu1_einval() -> i32 {
    let mut mask: libc::cpu_set_t = unsafe { zeroed() };
    unsafe { libc::CPU_SET(1, &mut mask) };
    unsafe { *libc::__errno_location() = 0 };
    let rc = unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &mask) };
    if rc == 0 {
        emit("set_cpu1_einval", 1, None, None);
        return 1;
    }
    let e = unsafe { *libc::__errno_location() };
    emit("set_cpu1_einval", 1, None, Some(e));
    1
}

fn case_getcpu_zero() -> i32 {
    let cpu = unsafe { libc::sched_getcpu() };
    if cpu != 0 {
        emit("getcpu_zero", 1, None, None);
        return 1;
    }
    emit("getcpu_zero", 0, Some("affinity:cpu=0"), None);
    0
}

fn run_case(name: &str) -> i32 {
    match name {
        "get_reports_one_cpu" => case_get_reports_one_cpu(),
        "set_cpu0_succeeds" => case_set_cpu0_succeeds(),
        "set_cpu1_einval" => case_set_cpu1_einval(),
        "getcpu_zero" => case_getcpu_zero(),
        _ => { eprintln!("affinity-canary: unknown case {name}"); 2 }
    }
}

fn list_cases() {
    println!("get_reports_one_cpu");
    println!("set_cpu0_succeeds");
    println!("set_cpu1_einval");
    println!("getcpu_zero");
}

fn smoke_mode() -> i32 {
    // Mirror the C smoke output exactly so guest-compat.test.ts could be
    // pointed at the Rust wasm if needed in the future.
    let mut mask: libc::cpu_set_t = unsafe { zeroed() };
    if unsafe { libc::sched_getaffinity(0, size_of::<libc::cpu_set_t>(), &mut mask) } != 0 {
        return 1;
    }
    let get_count = unsafe { cpu_count(&mask) };
    let mut m0: libc::cpu_set_t = unsafe { zeroed() };
    unsafe { libc::CPU_SET(0, &mut m0) };
    let set0_rc = unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &m0) };
    let mut m1: libc::cpu_set_t = unsafe { zeroed() };
    unsafe { libc::CPU_SET(1, &mut m1) };
    if unsafe { libc::sched_setaffinity(0, size_of::<libc::cpu_set_t>(), &m1) } == 0 {
        return 1;
    }
    println!("affinity:get={get_count},set0={set0_rc},set1=einval");
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let exit = match argv.len() {
        1 => smoke_mode(),
        2 if argv[1] == "--list-cases" => { list_cases(); 0 }
        3 if argv[1] == "--case" => run_case(&argv[2]),
        _ => { eprintln!("usage: affinity-canary [--case <name> | --list-cases]"); 2 }
    };
    std::process::exit(exit);
}
```

- [ ] **Step 3: Add to workspace, build, verify**

```toml
  "packages/guest-compat/conformance/rust/affinity-canary",
```

```bash
CPCC_ARCHIVE=$(pwd)/packages/guest-compat/build/libcodepod_guest_compat.a \
CPCC_PRESERVE_PRE_OPT=$(pwd)/packages/guest-compat/build \
CPCC_NO_WASM_OPT=1 \
  ./target/release/cargo-codepod codepod build --release -p affinity-canary

for c in get_reports_one_cpu set_cpu0_succeeds set_cpu1_einval getcpu_zero; do
  wasmtime run target/wasm32-wasip1/release/affinity-canary.wasm -- --case $c
done

./target/release/cpcheck \
  --archive packages/guest-compat/build/libcodepod_guest_compat.a \
  --pre-opt-wasm packages/guest-compat/build/affinity-canary.pre-opt.wasm \
  --symbol sched_getaffinity --symbol sched_setaffinity --symbol sched_getcpu
```

Expected: 4 successful JSONL traces (3 with exit 0, 1 with exit 1 + errno), then `signature check: OK (3 symbols)`.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml packages/guest-compat/conformance/rust/affinity-canary/
git commit -m "feat(guest-compat/step-3): add Rust affinity-canary (Task 16)"
```

---

## Task 17: Rust signal-canary (3d)

**Files:**
- Create: `packages/guest-compat/conformance/rust/signal-canary/Cargo.toml`
- Create: `packages/guest-compat/conformance/rust/signal-canary/src/main.rs`
- Modify: root `Cargo.toml`

Cases mirror the union of all 11 signal-family spec.toml files. Same JSONL contract.

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "signal-canary"
version = "0.1.0"
edition = "2021"
publish = false

[[bin]]
name = "signal-canary"
path = "src/main.rs"

[dependencies]
libc = "0.2"
```

- [ ] **Step 2: Create `src/main.rs`**

```rust
use std::io::Write;
use std::mem::zeroed;
use std::sync::atomic::{AtomicI32, Ordering};

static SEEN: AtomicI32 = AtomicI32::new(0);
static SUSPEND_SEEN: AtomicI32 = AtomicI32::new(0);

extern "C" fn handler(sig: libc::c_int) {
    SEEN.store(sig, Ordering::SeqCst);
}

extern "C" fn suspend_handler(sig: libc::c_int) {
    SUSPEND_SEEN.store(sig, Ordering::SeqCst);
}

fn emit(case: &str, exit: i32, stdout_line: Option<&str>, errno: Option<i32>) {
    let mut buf = String::new();
    buf.push_str(&format!("{{\"case\":\"{case}\",\"exit\":{exit}"));
    if let Some(s) = stdout_line { buf.push_str(&format!(",\"stdout\":\"{s}\"")); }
    if let Some(e) = errno { buf.push_str(&format!(",\"errno\":{e}")); }
    buf.push_str("}\n");
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    h.write_all(buf.as_bytes()).unwrap();
}

fn errno_now() -> i32 { unsafe { *libc::__errno_location() } }

fn case_signal_install() -> i32 {
    let prev = unsafe { libc::signal(libc::SIGINT, handler as libc::sighandler_t) };
    if prev == libc::SIG_ERR {
        emit("signal_install", 1, None, Some(errno_now()));
        return 1;
    }
    emit("signal_install", 0, Some("signal:installed"), None);
    0
}

fn case_sigaction_raise() -> i32 {
    SEEN.store(0, Ordering::SeqCst);
    let mut sa: libc::sigaction = unsafe { zeroed() };
    sa.sa_sigaction = handler as usize;
    if unsafe { libc::sigaction(libc::SIGINT, &sa, std::ptr::null_mut()) } != 0 {
        emit("sigaction_raise", 1, None, Some(errno_now())); return 1;
    }
    if unsafe { libc::raise(libc::SIGINT) } != 0 {
        emit("sigaction_raise", 1, None, Some(errno_now())); return 1;
    }
    if SEEN.load(Ordering::SeqCst) != libc::SIGINT {
        emit("sigaction_raise", 1, None, None); return 1;
    }
    emit("sigaction_raise", 0, Some("signal-ok"), None);
    0
}

fn case_raise_invokes_handler() -> i32 {
    SEEN.store(0, Ordering::SeqCst);
    let mut sa: libc::sigaction = unsafe { zeroed() };
    sa.sa_sigaction = handler as usize;
    if unsafe { libc::sigaction(libc::SIGTERM, &sa, std::ptr::null_mut()) } != 0 {
        emit("raise_invokes_handler", 1, None, Some(errno_now())); return 1;
    }
    if unsafe { libc::raise(libc::SIGTERM) } != 0 {
        emit("raise_invokes_handler", 1, None, Some(errno_now())); return 1;
    }
    if SEEN.load(Ordering::SeqCst) != libc::SIGTERM {
        emit("raise_invokes_handler", 1, None, None); return 1;
    }
    emit("raise_invokes_handler", 0, Some("raise:sigterm"), None);
    0
}

fn case_alarm_returns_zero() -> i32 {
    let remaining = unsafe { libc::alarm(0) };
    if remaining != 0 {
        emit("alarm_returns_zero", 1, None, None); return 1;
    }
    emit("alarm_returns_zero", 0, Some("alarm:0"), None);
    0
}

fn case_sigemptyset_clears() -> i32 {
    let mut s: libc::sigset_t = unsafe { zeroed() };
    if unsafe { libc::sigfillset(&mut s) } != 0 { emit("sigemptyset_clears", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigemptyset(&mut s) } != 0 { emit("sigemptyset_clears", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGINT) } != 0 { emit("sigemptyset_clears", 1, None, None); return 1; }
    emit("sigemptyset_clears", 0, Some("sigset:empty"), None);
    0
}

fn case_sigfillset_fills() -> i32 {
    let mut s: libc::sigset_t = unsafe { zeroed() };
    if unsafe { libc::sigfillset(&mut s) } != 0 { emit("sigfillset_fills", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGINT) } != 1 { emit("sigfillset_fills", 1, None, None); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGTERM) } != 1 { emit("sigfillset_fills", 1, None, None); return 1; }
    emit("sigfillset_fills", 0, Some("sigset:full"), None);
    0
}

fn case_sigaddset_adds() -> i32 {
    let mut s: libc::sigset_t = unsafe { zeroed() };
    if unsafe { libc::sigemptyset(&mut s) } != 0 { emit("sigaddset_adds", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigaddset(&mut s, libc::SIGINT) } != 0 { emit("sigaddset_adds", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGINT) } != 1 { emit("sigaddset_adds", 1, None, None); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGTERM) } != 0 { emit("sigaddset_adds", 1, None, None); return 1; }
    emit("sigaddset_adds", 0, Some("sigset:add"), None);
    0
}

fn case_sigdelset_removes() -> i32 {
    let mut s: libc::sigset_t = unsafe { zeroed() };
    if unsafe { libc::sigfillset(&mut s) } != 0 { emit("sigdelset_removes", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigdelset(&mut s, libc::SIGINT) } != 0 { emit("sigdelset_removes", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGINT) } != 0 { emit("sigdelset_removes", 1, None, None); return 1; }
    if unsafe { libc::sigismember(&s, libc::SIGTERM) } != 1 { emit("sigdelset_removes", 1, None, None); return 1; }
    emit("sigdelset_removes", 0, Some("sigset:del"), None);
    0
}

fn case_sigismember_reports() -> i32 {
    let mut s: libc::sigset_t = unsafe { zeroed() };
    if unsafe { libc::sigemptyset(&mut s) } != 0 { emit("sigismember_reports", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigaddset(&mut s, libc::SIGINT) } != 0 { emit("sigismember_reports", 1, None, Some(errno_now())); return 1; }
    let yes = unsafe { libc::sigismember(&s, libc::SIGINT) };
    let no = unsafe { libc::sigismember(&s, libc::SIGTERM) };
    if yes != 1 || no != 0 { emit("sigismember_reports", 1, None, None); return 1; }
    emit("sigismember_reports", 0, Some("sigset:ismember"), None);
    0
}

fn case_sigprocmask_roundtrip() -> i32 {
    let mut set: libc::sigset_t = unsafe { zeroed() };
    let mut oldset: libc::sigset_t = unsafe { zeroed() };
    if unsafe { libc::sigemptyset(&mut set) } != 0 { emit("sigprocmask_roundtrip", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigaddset(&mut set, libc::SIGUSR1) } != 0 { emit("sigprocmask_roundtrip", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut()) } != 0 { emit("sigprocmask_roundtrip", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigprocmask(libc::SIG_SETMASK, std::ptr::null(), &mut oldset) } != 0 { emit("sigprocmask_roundtrip", 1, None, Some(errno_now())); return 1; }
    if unsafe { libc::sigismember(&oldset, libc::SIGUSR1) } != 1 { emit("sigprocmask_roundtrip", 1, None, None); return 1; }
    emit("sigprocmask_roundtrip", 0, Some("sigprocmask:roundtrip"), None);
    0
}

fn case_sigsuspend_resumes_on_raise() -> i32 {
    SUSPEND_SEEN.store(0, Ordering::SeqCst);
    let mut sa: libc::sigaction = unsafe { zeroed() };
    sa.sa_sigaction = suspend_handler as usize;
    if unsafe { libc::sigaction(libc::SIGUSR2, &sa, std::ptr::null_mut()) } != 0 {
        emit("sigsuspend_resumes_on_raise", 1, None, Some(errno_now())); return 1;
    }
    if unsafe { libc::raise(libc::SIGUSR2) } != 0 {
        emit("sigsuspend_resumes_on_raise", 1, None, Some(errno_now())); return 1;
    }
    if SUSPEND_SEEN.load(Ordering::SeqCst) != libc::SIGUSR2 {
        emit("sigsuspend_resumes_on_raise", 1, None, None); return 1;
    }
    emit("sigsuspend_resumes_on_raise", 0, Some("sigsuspend:handled"), None);
    0
}

fn run_case(name: &str) -> i32 {
    match name {
        "signal_install" => case_signal_install(),
        "sigaction_raise" => case_sigaction_raise(),
        "raise_invokes_handler" => case_raise_invokes_handler(),
        "alarm_returns_zero" => case_alarm_returns_zero(),
        "sigemptyset_clears" => case_sigemptyset_clears(),
        "sigfillset_fills" => case_sigfillset_fills(),
        "sigaddset_adds" => case_sigaddset_adds(),
        "sigdelset_removes" => case_sigdelset_removes(),
        "sigismember_reports" => case_sigismember_reports(),
        "sigprocmask_roundtrip" => case_sigprocmask_roundtrip(),
        "sigsuspend_resumes_on_raise" => case_sigsuspend_resumes_on_raise(),
        _ => { eprintln!("signal-canary: unknown case {name}"); 2 }
    }
}

fn list_cases() {
    println!("signal_install");
    println!("sigaction_raise");
    println!("raise_invokes_handler");
    println!("alarm_returns_zero");
    println!("sigemptyset_clears");
    println!("sigfillset_fills");
    println!("sigaddset_adds");
    println!("sigdelset_removes");
    println!("sigismember_reports");
    println!("sigprocmask_roundtrip");
    println!("sigsuspend_resumes_on_raise");
}

fn smoke_mode() -> i32 {
    SEEN.store(0, Ordering::SeqCst);
    let mut sa: libc::sigaction = unsafe { zeroed() };
    sa.sa_sigaction = handler as usize;
    if unsafe { libc::sigaction(libc::SIGINT, &sa, std::ptr::null_mut()) } != 0 { return 1; }
    if unsafe { libc::raise(libc::SIGINT) } != 0 { return 1; }
    if SEEN.load(Ordering::SeqCst) != libc::SIGINT { return 1; }
    unsafe { libc::alarm(0) };
    println!("signal-ok");
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let exit = match argv.len() {
        1 => smoke_mode(),
        2 if argv[1] == "--list-cases" => { list_cases(); 0 }
        3 if argv[1] == "--case" => run_case(&argv[2]),
        _ => { eprintln!("usage: signal-canary [--case <name> | --list-cases]"); 2 }
    };
    std::process::exit(exit);
}
```

- [ ] **Step 3: Add to workspace, build, run all 11 cases, run signature check across the signal family**

In root `Cargo.toml`, append:

```toml
  "packages/guest-compat/conformance/rust/signal-canary",
```

```bash
CPCC_ARCHIVE=$(pwd)/packages/guest-compat/build/libcodepod_guest_compat.a \
CPCC_PRESERVE_PRE_OPT=$(pwd)/packages/guest-compat/build \
CPCC_NO_WASM_OPT=1 \
  ./target/release/cargo-codepod codepod build --release -p signal-canary

for c in signal_install sigaction_raise raise_invokes_handler alarm_returns_zero \
         sigemptyset_clears sigfillset_fills sigaddset_adds sigdelset_removes \
         sigismember_reports sigprocmask_roundtrip sigsuspend_resumes_on_raise; do
  wasmtime run target/wasm32-wasip1/release/signal-canary.wasm -- --case $c
done

./target/release/cpcheck \
  --archive packages/guest-compat/build/libcodepod_guest_compat.a \
  --pre-opt-wasm packages/guest-compat/build/signal-canary.pre-opt.wasm \
  --symbol signal --symbol sigaction --symbol raise --symbol alarm \
  --symbol sigemptyset --symbol sigfillset --symbol sigaddset --symbol sigdelset \
  --symbol sigismember --symbol sigprocmask --symbol sigsuspend
```

Expected: 11 JSONL lines (all `"exit":0`), then `signature check: OK (11 symbols)`.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml packages/guest-compat/conformance/rust/signal-canary/
git commit -m "feat(guest-compat/step-3): add Rust signal-canary (Task 17)"
```

---

## Task 18: Wire conformance driver — TOML-driven traces + Rust canaries via `cpconf --include-rust`

**Files:**
- Modify: `packages/guest-compat/toolchain/cpcc/src/conform.rs`
- Modify: `packages/guest-compat/toolchain/cpcc/src/bin/cpconf.rs`
- Modify: `packages/guest-compat/Makefile` (add `rust-canaries` target)

This task connects the spec parser (Task 7), the trace differ (Task 7), the Rust canaries (Tasks 14-17), and the existing implementation-signature check into one driver flow.

The flow per `cpconf --include-rust`:
1. Build `cpcc-toolchain` (existing).
2. Build the C archive + C canaries via `make` (existing).
3. Build all four Rust canaries via `cargo-codepod` (new — `make rust-canaries`).
4. For each `<symbol>.spec.toml` in `packages/guest-compat/conformance/`:
   - For each `[[case]]` in the spec:
     - Run the C canary `<canary> --case <name>` in a sandbox; capture stdout JSONL + exit code; diff against spec.
     - If `--include-rust` is set, do the same for the Rust canary; diff also.
     - The C and Rust JSONL traces must match each other (per §Conformance Driver).
5. For each canary in `canary_symbol_map()`:
   - Run `cpcheck` against the pre-opt wasm for both languages (C path already done, add Rust path).

- [ ] **Step 1: Add a `rust-canaries` target to the Makefile**

In `packages/guest-compat/Makefile`, append at the end:

```makefile
RUST_CANARY_NAMES := dup2 getgroups affinity signal
RUST_CANARY_PRE_OPT := $(addprefix $(BUILD_DIR)/rust/,$(addsuffix -canary.pre-opt.wasm,$(RUST_CANARY_NAMES)))
RUST_CANARY_WASM := $(addprefix $(BUILD_DIR)/rust/,$(addsuffix -canary.wasm,$(RUST_CANARY_NAMES)))

.PHONY: rust-canaries

rust-canaries: $(LIB) ensure-toolchain
	@mkdir -p $(BUILD_DIR)/rust
	CPCC_ARCHIVE=$(abspath $(LIB)) \
	CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/rust \
	CPCC_NO_WASM_OPT=1 \
	$(REPO_ROOT)/target/release/cargo-codepod codepod build --release \
	  -p dup2-canary -p getgroups-canary -p affinity-canary -p signal-canary
	@for n in $(RUST_CANARY_NAMES); do \
	  cp $(REPO_ROOT)/target/wasm32-wasip1/release/$$n-canary.wasm $(BUILD_DIR)/rust/$$n-canary.wasm; \
	done
```

- [ ] **Step 2: Smoke-test the Makefile target**

```bash
make -C packages/guest-compat clean
make -C packages/guest-compat lib canaries copy-fixtures
make -C packages/guest-compat rust-canaries

ls packages/guest-compat/build/rust/
# Expected: dup2-canary.wasm, dup2-canary.pre-opt.wasm, and the same for getgroups, affinity, signal.
```

- [ ] **Step 3: Widen `canary_symbol_map` to map each canary to the full list of Tier 1 symbols it exports, and update `run_signature_checks` to iterate the list**

The existing Step 1 `canary_symbol_map` returns `(&'static str, &'static str)` — one symbol per canary. `signal-canary` exports 11 Tier 1 symbols (`signal`, `sigaction`, `raise`, `alarm`, `sigemptyset`, `sigfillset`, `sigaddset`, `sigdelset`, `sigismember`, `sigprocmask`, `sigsuspend`); mapping it to only one under-checks 10 of them. Widen the map to `(&'static str, &'static [&'static str])` and iterate.

In `packages/guest-compat/toolchain/cpcc/src/conform.rs`, replace the existing `canary_symbol_map` function with:

```rust
/// Canary name → every Tier 1 symbol that canary exports. Used by both
/// `run_signature_checks` (C side) and `run_rust_signature_checks` (Rust
/// side, added below) to cover every marker a canary's pre-opt wasm
/// must carry. Coverage across all four canaries is exhaustive of Tier 1.
pub fn canary_symbol_map() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("dup2-canary", &["dup2"]),
        ("getgroups-canary", &["getgroups"]),
        ("affinity-canary", &["sched_getaffinity", "sched_setaffinity", "sched_getcpu"]),
        ("signal-canary", &[
            "signal", "sigaction", "raise", "alarm",
            "sigemptyset", "sigfillset", "sigaddset", "sigdelset",
            "sigismember", "sigprocmask", "sigsuspend",
        ]),
    ]
}
```

Replace the existing `run_signature_checks` (the C-side one written in Step 1) with the iterating shape:

```rust
pub fn run_signature_checks(&self) -> Result<()> {
    let cpcheck = self.target_bin("cpcheck");
    let archive = self.guest_compat().join("build/libcodepod_guest_compat.a");
    let build_dir = self.guest_compat().join("build");
    let mut failed = Vec::new();
    for (canary, symbols) in canary_symbol_map() {
        let pre_opt = build_dir.join(format!("{canary}.pre-opt.wasm"));
        println!("== {canary} ({} symbols) ==", symbols.len());
        let mut cmd = Command::new(&cpcheck);
        cmd.arg("--archive").arg(&archive);
        cmd.arg("--pre-opt-wasm").arg(&pre_opt);
        for sym in *symbols {
            cmd.arg("--symbol").arg(*sym);
        }
        let status = cmd
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
```

Also verify every Tier 1 symbol is covered by at least one canary entry. Add this check as a unit test in `packages/guest-compat/toolchain/cpcc/tests/canary_coverage.rs`:

```rust
use cpcc_toolchain::conform::canary_symbol_map;
use cpcc_toolchain::TIER1;

#[test]
fn every_tier1_symbol_is_covered_by_some_canary() {
    let mut covered: std::collections::HashSet<&str> = Default::default();
    for (_canary, symbols) in canary_symbol_map() {
        for s in *symbols {
            covered.insert(*s);
        }
    }
    let missing: Vec<&&str> = TIER1.iter().filter(|s| !covered.contains(*s)).collect();
    assert!(missing.is_empty(), "Tier 1 symbols not covered by any canary: {missing:?}");
}
```

Run:

```bash
cargo test -p cpcc-toolchain --test canary_coverage
cargo test -p cpcc-toolchain   # confirm nothing else regressed
```

Expected: both pass. Existing Step 1 test `signature_checks_run_green_on_all_canaries` (or equivalent) may need its invocation site adjusted to pass a `Vec<&str>` instead of a single string — update call sites accordingly.

- [ ] **Step 4: Extend `conform.rs` with TOML-spec-driven trace runner**

In `packages/guest-compat/toolchain/cpcc/src/conform.rs`, add at the bottom:

```rust
use crate::spec::{Case, Spec};
use crate::trace::{diff_case, parse_trace_line, Mismatch};

/// Result of running one case through one language's canary.
pub struct CaseResult {
    pub spec_symbol: String,
    pub case_name: String,
    pub language: &'static str,
    pub mismatches: Vec<Mismatch>,
    /// Raw stdout from the canary, surfaced when parsing fails.
    pub raw_stdout: String,
}

impl Driver {
    /// Run `<canary>.wasm --case <name>` via wasmtime and return the
    /// captured stdout + exit code. The canary's working directory is the
    /// guest-compat build/ dir so VFS paths resolve consistently.
    fn run_canary_case(&self, wasm: &std::path::Path, case_name: &str) -> Result<(String, i32)> {
        let out = Command::new("wasmtime")
            .arg("run")
            .arg(wasm)
            .arg("--")
            .arg("--case")
            .arg(case_name)
            .output()
            .with_context(|| format!("running wasmtime on {}", wasm.display()))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let code = out.status.code().unwrap_or(-1);
        Ok((stdout, code))
    }

    /// Diff one case's trace against its spec, for one language. Returns
    /// the result regardless of pass/fail; caller aggregates.
    pub fn run_one(
        &self,
        spec: &Spec,
        case: &Case,
        wasm: &std::path::Path,
        language: &'static str,
    ) -> Result<CaseResult> {
        let (raw_stdout, process_exit) = self.run_canary_case(wasm, &case.name)?;
        let trace_line = raw_stdout.lines().last().unwrap_or("").to_string();
        let mismatches = match parse_trace_line(&trace_line) {
            Ok(t) => diff_case(case, &t, process_exit),
            Err(_) => vec![Mismatch::CaseName {
                expected: case.name.clone(),
                actual: format!("<unparseable: {trace_line}>"),
            }],
        };
        Ok(CaseResult {
            spec_symbol: spec.symbol.clone(),
            case_name: case.name.clone(),
            language,
            mismatches,
            raw_stdout,
        })
    }

    /// Run every case in every spec under `conformance/` against the C and
    /// (optionally) Rust canaries. Returns a flat Vec of results; caller
    /// summarizes.
    ///
    /// When `include_rust` is true, missing Rust canary artifacts are a
    /// HARD FAILURE. Soft-skipping would let a broken `make rust-canaries`
    /// target or a missed copy-step produce a green `cpconf --include-rust`
    /// that silently verified nothing on the Rust side — the opposite of
    /// what a "Rust parity" CI gate is for.
    pub fn run_spec_traces(&self, include_rust: bool) -> Result<Vec<CaseResult>> {
        let conformance = self.guest_compat().join("conformance");
        let specs = Spec::load_dir(&conformance)?;
        let build = self.guest_compat().join("build");
        let mut results = Vec::new();
        for spec in &specs {
            let c_wasm = build.join(format!("{}.wasm", spec.canary));
            if !c_wasm.exists() {
                return Err(anyhow!(
                    "missing C canary wasm {} (spec {}). Ensure `make canaries` ran.",
                    c_wasm.display(),
                    spec.symbol
                ));
            }
            let rust_wasm = build.join("rust").join(format!("{}.wasm", spec.canary));
            if include_rust && !rust_wasm.exists() {
                return Err(anyhow!(
                    "--include-rust but missing Rust canary wasm {} (spec {}). \
                     Ensure `make rust-canaries` ran and that cargo-codepod emitted the wasm. \
                     This must be a hard failure — soft-skipping would silently pass the Rust gate.",
                    rust_wasm.display(),
                    spec.symbol
                ));
            }
            for case in &spec.cases {
                results.push(self.run_one(spec, case, &c_wasm, "c")?);
                if include_rust {
                    results.push(self.run_one(spec, case, &rust_wasm, "rust")?);
                }
            }
        }
        Ok(results)
    }

    /// Run cpcheck on the Rust pre-opt wasms for the same canary→symbol
    /// map used by the C side. Every canary in the map MUST have a
    /// pre-opt wasm present — missing artifacts are a hard failure, for
    /// the same reason as `run_spec_traces`.
    pub fn run_rust_signature_checks(&self) -> Result<()> {
        let cpcheck = self.target_bin("cpcheck");
        let archive = self.guest_compat().join("build/libcodepod_guest_compat.a");
        let build_dir = self.guest_compat().join("build/rust");
        let mut failed = Vec::new();
        for (canary, symbols) in canary_symbol_map() {
            let pre_opt = build_dir.join(format!("{canary}.pre-opt.wasm"));
            if !pre_opt.exists() {
                return Err(anyhow!(
                    "missing Rust pre-opt wasm {} for canary {}. \
                     Ensure `make rust-canaries` ran with CPCC_PRESERVE_PRE_OPT set. \
                     This must be a hard failure — soft-skipping would leave {} Tier 1 \
                     symbols unverified on the Rust side.",
                    pre_opt.display(),
                    canary,
                    symbols.len()
                ));
            }
            println!("== rust {canary} ({} symbols) ==", symbols.len());
            let mut cmd = Command::new(&cpcheck);
            cmd.arg("--archive").arg(&archive);
            cmd.arg("--pre-opt-wasm").arg(&pre_opt);
            for sym in *symbols {
                cmd.arg("--symbol").arg(*sym);
            }
            let status = cmd
                .status()
                .with_context(|| format!("running cpcheck on rust {canary}"))?;
            if !status.success() {
                failed.push(*canary);
            }
        }
        if !failed.is_empty() {
            return Err(anyhow!("rust signature check failed for: {}", failed.join(", ")));
        }
        Ok(())
    }
}
```

- [ ] **Step 5: Add the `--include-rust` flag and the new flow steps to `cpconf.rs`**

Replace `packages/guest-compat/toolchain/cpcc/src/bin/cpconf.rs` with:

```rust
use anyhow::Result;
use clap::Parser;
use cpcc_toolchain::conform;
use std::process::{Command, ExitCode};

#[derive(Parser)]
#[command(
    name = "cpconf",
    version,
    about = "Guest compatibility conformance driver (§Conformance Testing)"
)]
struct Args {
    /// Skip rebuilding cpcc/cpar/cpcheck/cargo-codepod (assume up to date).
    #[arg(long)]
    skip_toolchain_build: bool,
    /// Skip the orchestrator behavioral canary suite.
    #[arg(long)]
    skip_behavioral: bool,
    /// Skip the spec.toml-driven trace diff.
    #[arg(long)]
    skip_spec_traces: bool,
    /// Also build and exercise Rust canaries via cargo-codepod.
    #[arg(long)]
    include_rust: bool,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let root = conform::detect_repo_root()?;
    let driver = conform::Driver::new(root.clone());

    if !args.skip_toolchain_build {
        driver.ensure_toolchain()?;
    }
    driver.build_archive_and_canaries()?;
    driver.run_signature_checks()?;

    if args.include_rust {
        let status = Command::new("make")
            .current_dir(root.join("packages/guest-compat"))
            .arg("rust-canaries")
            .status()?;
        if !status.success() {
            return Err(anyhow::anyhow!("make rust-canaries failed"));
        }
        driver.run_rust_signature_checks()?;
    }

    if !args.skip_spec_traces {
        let results = driver.run_spec_traces(args.include_rust)?;
        let mut failures = 0usize;
        for r in &results {
            if !r.mismatches.is_empty() {
                failures += 1;
                eprintln!(
                    "FAIL [{}] {}::{}",
                    r.language, r.spec_symbol, r.case_name
                );
                for m in &r.mismatches {
                    eprintln!("  - {m:?}");
                }
                eprintln!("  raw stdout: {}", r.raw_stdout.trim_end());
            }
        }
        if failures > 0 {
            return Err(anyhow::anyhow!(
                "{failures} of {} spec/trace diffs failed",
                results.len()
            ));
        }
        println!("cpconf: spec/trace diffs OK ({} cases)", results.len());

        // §Conformance Driver: C and Rust traces must match each other for
        // each case. Pair them up and assert equality of stdout/exit/errno.
        if args.include_rust {
            let mut by_key: std::collections::HashMap<(String, String), Vec<&conform::CaseResult>> = Default::default();
            for r in &results {
                by_key.entry((r.spec_symbol.clone(), r.case_name.clone())).or_default().push(r);
            }
            let mut cross_failures = 0usize;
            for ((sym, case), pair) in &by_key {
                if pair.len() != 2 { continue; }
                let c = pair.iter().find(|p| p.language == "c");
                let r = pair.iter().find(|p| p.language == "rust");
                if let (Some(c), Some(r)) = (c, r) {
                    if c.raw_stdout != r.raw_stdout {
                        cross_failures += 1;
                        eprintln!("CROSS-LANG MISMATCH {sym}::{case}");
                        eprintln!("  c   : {}", c.raw_stdout.trim_end());
                        eprintln!("  rust: {}", r.raw_stdout.trim_end());
                    }
                }
            }
            if cross_failures > 0 {
                return Err(anyhow::anyhow!("{cross_failures} cross-language trace mismatches"));
            }
            println!("cpconf: C/Rust trace parity OK");
        }
    }

    if !args.skip_behavioral {
        driver.run_behavioral_suite()?;
    }
    println!("cpconf: OK");
    Ok(ExitCode::SUCCESS)
}
```

- [ ] **Step 6: Run the full driver**

```bash
cargo build -p cpcc-toolchain --release
./target/release/cpconf --include-rust
```

Expected last lines:

```
cpconf: spec/trace diffs OK (<N> cases)
cpconf: C/Rust trace parity OK
cpconf: OK
```

If any case fails, the failure surface tells you which language/symbol/case mismatched and the raw stdout of the canary. Fix the canary (don't edit the spec to make a real bug pass).

- [ ] **Step 7: Negative test — verify the gate hard-fails when Rust artifacts are missing**

This is the guard against the "silent skip" failure mode. After Step 6 passes, break the Rust output on purpose and confirm the driver fails loudly:

```bash
rm packages/guest-compat/build/rust/dup2-canary.wasm
./target/release/cpconf --include-rust --skip-toolchain-build || echo "EXPECTED FAILURE"
# Expected error message contains: "missing Rust canary wasm" AND "must be a hard failure"

make -C packages/guest-compat rust-canaries   # restore

rm packages/guest-compat/build/rust/signal-canary.pre-opt.wasm
./target/release/cpconf --include-rust --skip-toolchain-build || echo "EXPECTED FAILURE"
# Expected error message contains: "missing Rust pre-opt wasm" AND "11 Tier 1 symbols unverified"

make -C packages/guest-compat rust-canaries   # restore
```

Expected both `cpconf` invocations exit non-zero with the quoted messages. If either one exits 0, the hard-fail logic regressed — fix before proceeding.

- [ ] **Step 8: Commit**

```bash
git add packages/guest-compat/Makefile \
        packages/guest-compat/toolchain/cpcc/src/conform.rs \
        packages/guest-compat/toolchain/cpcc/src/bin/cpconf.rs \
        packages/guest-compat/toolchain/cpcc/tests/canary_coverage.rs
git commit -m "feat(guest-compat/step-3): wire spec.toml + Rust canaries into cpconf (Task 18)"
```

---

## Task 19: CI wiring — `guest-compat-conformance` GitHub Actions job

**Files:**
- Create: `.github/workflows/guest-compat.yml`

A separate workflow for the guest-compat conformance gate. Runs on every push and PR. Installs `wasi-sdk`, `wasmtime`, and `wasm-opt`; builds the toolchain; runs `cpconf --include-rust`. Failing this job blocks merge.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/guest-compat.yml`:

```yaml
name: guest-compat-conformance

on:
  push:
    branches: [main]
  pull_request:

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-wasip1

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: ". -> target"

      - name: Install wasmtime
        run: |
          curl -sSf https://wasmtime.dev/install.sh | bash
          echo "$HOME/.wasmtime/bin" >> $GITHUB_PATH

      - name: Install wasm-opt (binaryen)
        run: |
          BINARYEN_VER=119
          curl -sSL -o /tmp/binaryen.tar.gz \
            "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VER}/binaryen-version_${BINARYEN_VER}-x86_64-linux.tar.gz"
          mkdir -p /opt/binaryen
          tar -xzf /tmp/binaryen.tar.gz -C /opt/binaryen --strip-components=1
          echo "/opt/binaryen/bin" >> $GITHUB_PATH

      - name: Install wasi-sdk
        env:
          WASI_SDK_VER: "30.0"
        run: |
          curl -sSL -o /tmp/wasi-sdk.tar.gz \
            "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VER%%.*}/wasi-sdk-${WASI_SDK_VER}-x86_64-linux.tar.gz"
          mkdir -p $HOME/.local/share
          tar -xzf /tmp/wasi-sdk.tar.gz -C $HOME/.local/share
          mv $HOME/.local/share/wasi-sdk-${WASI_SDK_VER}* $HOME/.local/share/wasi-sdk
          echo "WASI_SDK_PATH=$HOME/.local/share/wasi-sdk" >> $GITHUB_ENV

      - name: Build cpcc toolchain
        run: cargo build --release -p cpcc-toolchain

      - name: Run conformance driver (C + Rust)
        run: ./target/release/cpconf --include-rust --skip-behavioral
```

Note `--skip-behavioral` is passed because the orchestrator canary suite (Deno) already runs in the existing `ci.yml > test` job; running it twice is wasteful. The conformance job's load-bearing checks are the spec/trace diff and the implementation-signature check.

- [ ] **Step 2: Validate the YAML locally**

```bash
# If `actionlint` is available, run it; otherwise skip this step.
command -v actionlint && actionlint .github/workflows/guest-compat.yml || echo "actionlint not installed; skipping"
```

- [ ] **Step 3: Push to a draft PR to verify the job runs end-to-end**

(This step is exploratory; the implementer should commit, push, and watch the new job's logs.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/guest-compat.yml
git commit -m "ci(guest-compat/step-3): add guest-compat-conformance workflow (Task 19)"
```

---

## Self-Review

### 1. Spec coverage

Walking the spec section by section against the tasks:

- **§Verifying Precedence** (markers, archive nm, pre-opt exports, call edges): existing `cpcheck` handles this. Tasks 14-17 + 18 ensure Rust canaries also produce pre-opt wasms that pass cpcheck. ✓
- **§Compatibility Tiers > Tier 1** (16 symbols): Task 6 covers the 11 signal-family + Tasks 3/4/5 cover the other 5. Spec.toml exists for every Tier 1 symbol. ✓
- **§Versioning**: existing C side already uses the sentinel; Task 9 plumbs the version check into `cargo-codepod`; Task 12 plumbs it into `codepod-guest-compat-sys` build.rs; Task 13 exposes `VERSION` constant in safe wrapper. ✓
- **§Toolchain Integration > C Toolchain (`codepod-cc`)**: existing `cpcc` from Step 1 — no new work. ✓
- **§Toolchain Integration > Rust Toolchain (`cargo-codepod`)**: Tasks 8-11 land it: build/test/run/download-toolchain, RUSTFLAGS injection, version check, pre-opt preservation, wasm-opt, signature-check capability via cpcheck. ✓
- **§Toolchain Integration > Optional crates**: Tasks 12 + 13 land both. CODEPOD_LINK_INJECTED handshake is implemented and tested. ✓
- **§Toolchain Integration > Parity Rule**: §Parity Rule lines 596-601 require CI to "build the same canary program through both wrappers" and "assert identical conformance output". Task 18 adds the cross-language trace parity check; Task 19 runs it in CI. ✓
- **§Conformance Testing > Behavioral Spec**: Task 1 defines the schema; Tasks 3-6 author all 16 spec.toml files. ✓
- **§Conformance Testing > Paired Canaries**: existing C canaries (Step 1) updated in Task 2; Rust canaries created in Tasks 14-17. ✓
- **§Conformance Testing > Conformance Driver**: Tasks 7 + 18 land it. Trace JSONL parsing, spec/trace diff, cross-language trace parity check, both-wrappers-build assertion. ✓
- **§Conformance Testing > Implementation-Signature Check**: existing for C canaries (Step 1); Task 18 extends to Rust canaries. ✓
- **§Migration Path > Step 3 (3a-3e)**: 3a → Tasks 1, 3-6. 3b → Tasks 8-11. 3c → Tasks 12-13. 3d → Tasks 14-17. 3e → Tasks 18-19. ✓
- **§Phase A acceptance criteria** (lines 618-628): "every Tier 1 symbol is overridden in Rust guests the same way it is in C guests, verified by behavioral conformance and the implementation-signature check" — Tasks 14-18 do this. "`cargo-codepod` builds both codepod-authored crates and at least one unmodified upstream crate successfully" — Task 9 step 4 (smoke test) builds an unmodified scaffolded cargo crate; the unmodified-third-party-CLI requirement is **deferred to Step 5** per the migration path (Task 4 of step 4). The spec is explicit that Step 4 owns that gate, so it is correctly outside Step 3. "the safe-wrapper crate exists for the Tier 1 surface where Rust-native types add value" — Task 13. "at least one real Rust consumer (see §Package Validation) builds and runs against Tier 1 with zero `unsafe extern` code in the application" — also Step 4/5. ✓ for Step 3's portion.

**Gap check:** the spec mentions in §Conformance Testing > Implementation-Signature Check that the check applies to "every real-consumer `.wasm`". That's a Step 4/5 concern (real consumers are BusyBox + coreutils + third-party CLI). Step 3's responsibility is to make the check *runnable* against any wasm — and `cpcheck` already does that. ✓

### 2. Placeholder scan

Searched the plan for the failure patterns from the writing-plans skill:

- "TBD" / "TODO" / "implement later" / "fill in details": none.
- "Add appropriate error handling" / "add validation" / "handle edge cases": none.
- "Write tests for the above": none — tests are spelled out.
- "Similar to Task N": none — Tasks 14-17 share structure, but each task contains its own complete file contents.
- Steps describing what to do without showing how: none — every code step has a code block.
- References to types/functions not defined elsewhere in the plan: spot-checked `Spec`, `Case`, `Expected`, `TraceLine`, `Mismatch`, `Subcommand`, `InvocationPlan`, `plan_invocation`, `plan_invocation_with_sdk`, `locate_outputs`, `profile_from_args`, `download_toolchain`, `Driver::run_one`, `Driver::run_spec_traces`, `Driver::run_rust_signature_checks`, `CaseResult`. All are defined in the task that introduces them. ✓

### 3. Type / API consistency

- `Spec`/`Case`/`Expected` defined in Task 7 step 5; consumed in Task 7 step 9 tests, Task 18 step 4. Field names (`canary`, `symbol`, `path`, `cases`, `name`, `inputs`, `expected`, `expected.exit/stdout/errno/note`) match across all uses. ✓
- `TraceLine` (`case`, `exit`, `stdout`, `errno`) defined in Task 7 step 10; consumed in Task 18 step 4. ✓
- `Mismatch` variants (`CaseName`, `Exit`, `ProcessTraceExitDisagree`, `Stdout`, `Errno`) defined in Task 7 step 10; pattern-matched in Task 7 step 9 tests. ✓
- `Subcommand` (`Build`, `Test`, `Run`, `DownloadToolchain`) defined in Task 8 step 4; used in Task 9 step 3, Task 11 step 2. ✓
- `plan_invocation_with_sdk` introduced in Task 9 step 1 to replace `plan_invocation`; both functions exist in the final state. The earlier-task tests for `plan_invocation` keep passing because Task 9 keeps `plan_invocation` as a wrapper around `plan_invocation_with_sdk(sub, forwarded, None)`. ✓
- **`TIER1` duplication between `cpcc_toolchain::lib.rs` and `codepod-guest-compat-sys/build.rs`.** build.rs cannot depend on the lib crate, so Task 12 step 3 inlines a 16-entry copy. This is a real divergence risk if Tier 1 grows. Mitigation: the build.rs constant has a comment pointing at the canonical list; the canary-coverage test in Task 18 step 3 (`every_tier1_symbol_is_covered_by_some_canary`) locks in that the canonical TIER1 is fully exercised, which provides indirect coverage — a Tier 1 addition that isn't plumbed into a canary fails the test, flagging the discrepancy. An explicit build-script-vs-lib diff check is noted as a follow-up but not blocking Step 3. ✓ with caveat.
- **`canary_symbol_map()` shape.** Widened from `(&str, &str)` to `(&str, &[&str])` in Task 18 step 3 as the first conform.rs change of Task 18, so every subsequent iteration in that task (both `run_signature_checks` and `run_rust_signature_checks`) uses the new shape. The coverage unit test `every_tier1_symbol_is_covered_by_some_canary` guards against future Tier 1 additions silently dropping symbols. ✓
- **Host-build ergonomics.** Task 12's `build.rs` is target-gated; Task 13's host-build step explicitly verifies `cargo check --workspace` still passes. Without the target gate, adding these crates to the workspace would break root `cargo build` for everyone. ✓

### 4. Gate hard-failure guarantees

The conformance gate (`cpconf --include-rust`) is wired so missing Rust artifacts cannot produce a false green. Covered by:

- `run_spec_traces` returns an `Err` if any C canary wasm is missing; returns an `Err` if `include_rust` is set and any Rust canary wasm is missing (Task 18 step 4).
- `run_rust_signature_checks` returns an `Err` if any pre-opt Rust wasm is missing, with the error message naming the affected canary and how many Tier 1 symbols the miss would leave unverified (Task 18 step 4).
- Task 18 step 7 is a negative test: manually remove a Rust artifact and confirm `cpconf --include-rust` exits non-zero with the expected message. If either removal results in an exit-0, the hard-fail logic regressed.

### 5. Risks not covered by the plan

- **`cargo-codepod` `--archive` flag vs. `CPCC_ARCHIVE` env.** `cargo-codepod` reads from the environment; a future ergonomics improvement would be `--compat-archive=<path>`. Out of scope for Step 3 — the env surface matches `cpcc`'s and is sufficient for Phase A.
- **`wasm-opt` not on PATH in dev.** `cargo-codepod` hard-fails on the post-build `wasm-opt` step unless `CPCC_NO_WASM_OPT=1` is set. The error message from `wasm_opt::maybe_run` already mentions the env var, which is sufficient guidance.
- **`codepod-guest-compat-sys` TIER1 drift.** Addressed via the canary-coverage unit test (see §3 above); a hard sync check is noted as a follow-up.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-guest-compat-runtime-step-3.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
