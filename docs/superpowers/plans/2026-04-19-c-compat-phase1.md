# Phase 1 C Compatibility Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a supported phase-1 path for compiling standalone C programs to codepod WASM executables, add the first explicit compatibility extension for command execution, and ship a host-side, maturin-like C/WASI builder plus a BusyBox pilot recipe that can replace selected built-in tools.

**Architecture:** Keep `wasi-libc` as the base ABI and add a tiny `codepod-compat` C layer on top. Phase 1 standardizes a host-side, recipe-driven builder around `clang`/`wasi-sdk` that plays the same role `maturin` plays for Rust Python extensions: toolchain discovery, common flags, recipe execution, patch/shim injection, and artifact packaging. On top of that builder, phase 1 adds a narrow subprocess-style extension (`system()` / `popen()`-class behavior routed through `host_run_command`) and validates the builder with a BusyBox multi-call recipe registered through VFS symlinks for selected applets rather than claiming broad POSIX compatibility up front.

**Tech Stack:** `wasi-sdk`, `clang`, shell scripting, C, `wasi-libc`, BusyBox, WebAssembly imports, Deno tests, TypeScript orchestrator, existing `host_run_command` runtime path

---

## File Structure

### New files

- `packages/c-compat/README.md` — top-level description of the C compatibility layer, its scope, and build prerequisites.
- `packages/c-compat/Makefile` — reproducible build for the compatibility library and canary executables.
- `packages/c-compat/include/codepod_compat.h` — public header for codepod-specific C compatibility functions.
- `packages/c-compat/src/codepod_command.c` — implementation of command-execution helpers on top of `codepod.host_run_command`.
- `packages/c-compat/src/codepod_runtime.h` — private declarations for import bindings and shared helpers.
- `packages/c-compat/examples/stdio_canary.c` — plain WASI file/stdio canary.
- `packages/c-compat/examples/sleep_canary.c` — timeout / sleep canary.
- `packages/c-compat/examples/system_canary.c` — command-execution canary using the compatibility layer.
- `packages/c-compat/examples/popen_canary.c` — pipe/capture canary using the compatibility layer.
- `packages/c-builder/README.md` — user-facing documentation for the host-side, maturin-like C/WASI builder.
- `scripts/build-c-port.sh` — reusable host-side builder entrypoint around `clang` / `wasi-sdk`.
- `packages/c-ports/busybox/Makefile` — BusyBox build entrypoint using the shared `wasi-sdk` conventions.
- `packages/c-ports/busybox/busybox.config` — pinned BusyBox applet/config set for codepod.
- `packages/c-ports/busybox/README.md` — what applets are enabled and how they map into codepod.
- `packages/orchestrator/src/__tests__/c-compat.test.ts` — end-to-end tests for the phase-1 C surface.
- `scripts/build-c-compat.sh` — helper that builds the library and canary executables and copies outputs into fixtures when requested.

### Existing files to modify

- `docs/guides/syscalls.md` — document `host_run_command` as a stable extension input for future C shims, not only Python.
- `docs/guides/creating-commands.md` — add a short “building C executables” section that points to `packages/c-compat/`.
- `docs/guides/package-manager.md` — clarify that `pkg` installs standalone WASM executables, including multi-call C tools wrapped by symlinks.
- `scripts/build-c-compat.sh` — migrate the canary build to the shared harness once it exists.
- `packages/orchestrator/src/process/manager.ts` — add a narrow registration helper for a multi-call binary plus selected applet symlinks if the existing registration flow is too single-binary-centric.
- `packages/orchestrator/src/sandbox.ts` — wire BusyBox registration at sandbox startup if the process-manager helper lands here instead.
- `docs/superpowers/specs/2026-04-19-c-abi-compatibility-design.md` — update status notes if implementation details force any small terminology changes.

### Existing files to read during implementation

- `packages/orchestrator/src/host-imports/kernel-imports.ts`
- `packages/orchestrator/src/process/subprocess-shim.ts`
- `packages/orchestrator/src/sandbox.ts`
- `packages/orchestrator/src/process/manager.ts`
- `packages/orchestrator/src/sandbox.ts`
- `docs/guides/syscalls.md`
- `docs/guides/creating-commands.md`
- `scripts/build-c-compat.sh`
- `packages/orchestrator/src/shell/__tests__/conformance/grep-busybox.test.ts`
- `packages/orchestrator/src/shell/__tests__/conformance/head-busybox.test.ts`
- `packages/orchestrator/src/shell/__tests__/conformance/seq-busybox.test.ts`

---

### Task 1: Scaffold `codepod-compat` And Build Plain-WASI Canary Programs

**Files:**
- Create: `packages/c-compat/README.md`
- Create: `packages/c-compat/Makefile`
- Create: `packages/c-compat/include/codepod_compat.h`
- Create: `packages/c-compat/src/codepod_runtime.h`
- Create: `packages/c-compat/examples/stdio_canary.c`
- Create: `packages/c-compat/examples/sleep_canary.c`
- Create: `scripts/build-c-compat.sh`
- Test: `packages/orchestrator/src/__tests__/c-compat.test.ts`

- [ ] **Step 1: Write the failing end-to-end tests for plain C/WASI canaries**

```ts
import { describe, it, expect, beforeAll } from 'bun:test';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dir, 'platform/__tests__/fixtures');

describe('C compatibility canaries', () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await Sandbox.create({
      adapter: new NodeAdapter(),
      wasmDir: FIXTURES,
    });
  });

  it('runs stdio_canary.wasm as a normal command', async () => {
    const result = await sandbox.run('stdio-canary /tmp/in.txt /tmp/out.txt');
    expect(result.exitCode).toBe(0);
  });

  it('runs sleep_canary.wasm and returns after a short delay', async () => {
    const result = await sandbox.run('sleep-canary 5');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('slept:5');
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails because the canaries do not exist yet**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/c-compat.test.ts`

Expected: FAIL with command resolution errors for `stdio-canary` and `sleep-canary`.

- [ ] **Step 3: Create the public header and private runtime header**

```c
/* packages/c-compat/include/codepod_compat.h */
#ifndef CODEPOD_COMPAT_H
#define CODEPOD_COMPAT_H

#include <stdio.h>

int codepod_system(const char *cmd);
FILE *codepod_popen(const char *cmd, const char *mode);
int codepod_pclose(FILE *stream);

#endif
```

```c
/* packages/c-compat/src/codepod_runtime.h */
#ifndef CODEPOD_RUNTIME_H
#define CODEPOD_RUNTIME_H

#include <stddef.h>

__attribute__((import_module("codepod"), import_name("host_run_command")))
int codepod_host_run_command(int req_ptr, int req_len, int out_ptr, int out_cap);

int codepod_json_call(const char *json, char *out, size_t out_cap);

#endif
```

- [ ] **Step 4: Add the plain-WASI canary programs**

```c
/* packages/c-compat/examples/stdio_canary.c */
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: stdio-canary <in> <out>\n");
        return 2;
    }

    FILE *in = fopen(argv[1], "r");
    if (!in) {
        perror("fopen input");
        return 1;
    }

    FILE *out = fopen(argv[2], "w");
    if (!out) {
        perror("fopen output");
        fclose(in);
        return 1;
    }

    int ch;
    while ((ch = fgetc(in)) != EOF) {
        fputc(ch, out);
    }

    fclose(in);
    fclose(out);
    puts("stdio-ok");
    return 0;
}
```

```c
/* packages/c-compat/examples/sleep_canary.c */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: sleep-canary <millis>\n");
        return 2;
    }

    long millis = strtol(argv[1], NULL, 10);
    struct timespec req;
    req.tv_sec = millis / 1000;
    req.tv_nsec = (millis % 1000) * 1000000L;
    nanosleep(&req, NULL);
    printf("slept:%ld\n", millis);
    return 0;
}
```

- [ ] **Step 5: Add the build files for the compatibility package**

```make
# packages/c-compat/Makefile
WASI_SDK_PATH ?= $(HOME)/.local/share/wasi-sdk-30.0-arm64-macos
CC := $(WASI_SDK_PATH)/bin/clang
SYSROOT := $(WASI_SDK_PATH)/share/wasi-sysroot
REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures

CFLAGS := --sysroot=$(SYSROOT) --target=wasm32-wasi -O2 -Iinclude
LDFLAGS :=

.PHONY: all copy-fixtures clean

all: stdio-canary.wasm sleep-canary.wasm

stdio-canary.wasm: examples/stdio_canary.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<

sleep-canary.wasm: examples/sleep_canary.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<

copy-fixtures: all
	cp stdio-canary.wasm $(FIXTURES)/stdio-canary.wasm
	cp sleep-canary.wasm $(FIXTURES)/sleep-canary.wasm

clean:
	rm -f stdio-canary.wasm sleep-canary.wasm
```

```bash
# scripts/build-c-compat.sh
#!/bin/bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/packages/c-compat"
make "${1:-all}"
```

- [ ] **Step 6: Add a short README explaining phase 1 scope**

```md
# codepod C Compatibility

Phase 1 provides:

- a supported `wasi-sdk` build path for standalone C executables
- plain-WASI canaries for stdio and sleep/polling behavior
- a tiny codepod-specific extension library for command execution

Phase 1 does not provide:

- full POSIX compatibility
- guest `pthread` guarantees
- sockets as standard libc APIs
- shared libraries
```

- [ ] **Step 7: Build the canaries and copy them into fixtures**

Run: `bash scripts/build-c-compat.sh copy-fixtures`

Expected: `stdio-canary.wasm` and `sleep-canary.wasm` appear under `packages/orchestrator/src/platform/__tests__/fixtures/`.

- [ ] **Step 8: Run the end-to-end tests and verify they now pass**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/c-compat.test.ts`

Expected: PASS for the plain canary cases.

- [ ] **Step 9: Commit**

```bash
git add packages/c-compat/README.md packages/c-compat/Makefile packages/c-compat/include/codepod_compat.h packages/c-compat/src/codepod_runtime.h packages/c-compat/examples/stdio_canary.c packages/c-compat/examples/sleep_canary.c scripts/build-c-compat.sh packages/orchestrator/src/platform/__tests__/fixtures/stdio-canary.wasm packages/orchestrator/src/platform/__tests__/fixtures/sleep-canary.wasm packages/orchestrator/src/__tests__/c-compat.test.ts
git commit -m "feat: add phase-1 C compatibility scaffold and WASI canaries"
```

### Task 2: Add The First Explicit C Compatibility Extension For Command Execution

**Files:**
- Modify: `packages/c-compat/Makefile`
- Create: `packages/c-compat/src/codepod_command.c`
- Create: `packages/c-compat/examples/system_canary.c`
- Create: `packages/c-compat/examples/popen_canary.c`
- Modify: `packages/orchestrator/src/__tests__/c-compat.test.ts`
- Modify: `docs/guides/syscalls.md`

- [ ] **Step 1: Extend the failing tests to cover command-execution compatibility**

```ts
it('runs system_canary.wasm through host_run_command', async () => {
  const result = await sandbox.run('system-canary');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toContain('system-ok');
});

it('runs popen_canary.wasm and captures command output', async () => {
  const result = await sandbox.run('popen-canary');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('popen:hello-from-shell');
});
```

- [ ] **Step 2: Run the test file and verify the new cases fail**

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/c-compat.test.ts`

Expected: FAIL with `system-canary: command not found` and `popen-canary: command not found`.

- [ ] **Step 3: Implement the phase-1 command-execution shim**

```c
/* packages/c-compat/src/codepod_command.c */
#include "codepod_compat.h"
#include "codepod_runtime.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int extract_exit_code(const char *json) {
    const char *p = strstr(json, "\"exit_code\":");
    if (!p) return 1;
    return atoi(p + strlen("\"exit_code\":"));
}

static int extract_stdout(const char *json, char *dst, size_t dst_cap) {
    const char *p = strstr(json, "\"stdout\":\"");
    if (!p || dst_cap == 0) return -1;
    p += strlen("\"stdout\":\"");
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < dst_cap) {
        if (*p == '\\' && *(p + 1) != '\0') p++;
        dst[i++] = *p++;
    }
    dst[i] = '\0';
    return 0;
}

int codepod_json_call(const char *json, char *out, size_t out_cap) {
    return codepod_host_run_command((int)json, (int)strlen(json), (int)out, (int)out_cap);
}

int codepod_system(const char *cmd) {
    char req[1024];
    char out[4096];
    snprintf(req, sizeof(req), "{\"cmd\":\"%s\"}", cmd);
    int n = codepod_json_call(req, out, sizeof(out));
    if (n < 0) {
        errno = EIO;
        return -1;
    }
    return extract_exit_code(out);
}

FILE *codepod_popen(const char *cmd, const char *mode) {
    if (strcmp(mode, "r") != 0) {
        errno = ENOTSUP;
        return NULL;
    }

    char req[1024];
    static char out[4096];
    snprintf(req, sizeof(req), "{\"cmd\":\"%s\"}", cmd);
    int n = codepod_json_call(req, out, sizeof(out));
    if (n < 0) {
        errno = EIO;
        return NULL;
    }

    static char stdout_buf[2048];
    if (extract_stdout(out, stdout_buf, sizeof(stdout_buf)) != 0) {
        errno = EIO;
        return NULL;
    }

    FILE *fp = tmpfile();
    if (!fp) return NULL;
    fputs(stdout_buf, fp);
    rewind(fp);
    return fp;
}

int codepod_pclose(FILE *stream) {
    return fclose(stream);
}
```

- [ ] **Step 4: Add canary programs that exercise the shim**

```c
/* packages/c-compat/examples/system_canary.c */
#include "codepod_compat.h"
#include <stdio.h>

int main(void) {
    int rc = codepod_system("echo system-ok");
    if (rc != 0) return rc;
    puts("system-ok");
    return 0;
}
```

```c
/* packages/c-compat/examples/popen_canary.c */
#include "codepod_compat.h"
#include <stdio.h>

int main(void) {
    FILE *fp = codepod_popen("echo hello-from-shell", "r");
    if (!fp) {
        perror("codepod_popen");
        return 1;
    }

    char buf[128];
    if (!fgets(buf, sizeof(buf), fp)) {
        codepod_pclose(fp);
        return 1;
    }
    codepod_pclose(fp);
    printf("popen:%s", buf);
    return 0;
}
```

- [ ] **Step 5: Update the Makefile to build the library-backed canaries**

```make
# additional targets in packages/c-compat/Makefile
all: stdio-canary.wasm sleep-canary.wasm system-canary.wasm popen-canary.wasm

CODEPOD_LIB := src/codepod_command.c

system-canary.wasm: examples/system_canary.c $(CODEPOD_LIB)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(CODEPOD_LIB) $<

popen-canary.wasm: examples/popen_canary.c $(CODEPOD_LIB)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(CODEPOD_LIB) $<

copy-fixtures: all
	cp system-canary.wasm $(FIXTURES)/system-canary.wasm
	cp popen-canary.wasm $(FIXTURES)/popen-canary.wasm
```

- [ ] **Step 6: Document `host_run_command` as a general guest extension path**

```md
Add to `docs/guides/syscalls.md`:

- `host_run_command` is currently used by Python subprocess shims.
- It is also the intended low-level primitive for an optional C compatibility layer implementing `system()` / `popen()`-style APIs.
- It is an extension API, not a POSIX process syscall.
```

- [ ] **Step 7: Build, copy fixtures, and run the tests**

Run: `bash scripts/build-c-compat.sh copy-fixtures`

Expected: `system-canary.wasm` and `popen-canary.wasm` appear in fixtures.

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/c-compat.test.ts`

Expected: PASS for all four canary cases.

- [ ] **Step 8: Commit**

```bash
git add packages/c-compat/Makefile packages/c-compat/src/codepod_command.c packages/c-compat/examples/system_canary.c packages/c-compat/examples/popen_canary.c packages/orchestrator/src/platform/__tests__/fixtures/system-canary.wasm packages/orchestrator/src/platform/__tests__/fixtures/popen-canary.wasm packages/orchestrator/src/__tests__/c-compat.test.ts docs/guides/syscalls.md
git commit -m "feat: add phase-1 C command execution compatibility"
```

### Task 3: Build The Host-Side, Maturin-Like C/WASI Builder

**Files:**
- Create: `packages/c-builder/README.md`
- Create: `scripts/build-c-port.sh`
- Modify: `scripts/build-c-compat.sh`
- Modify: `packages/c-compat/Makefile`
- Modify: `docs/guides/creating-commands.md`
- Modify: `packages/c-compat/README.md`
- Test: `packages/orchestrator/src/__tests__/c-compat.test.ts`

- [ ] **Step 1: Add a failing smoke check for the shared builder entrypoint**

```bash
Run: `bash scripts/build-c-port.sh --help`
Expected: command not found or usage not implemented yet
```

- [ ] **Step 2: Create the host-side builder around `clang` / `wasi-sdk`**

```bash
# scripts/build-c-port.sh
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  build-c-port.sh --source <file.c> --output <file.wasm> [--include <dir>]... [--cflag <flag>]... [--ldflag <flag>]...
EOF
}

find_wasi_sdk() {
  for path in \
    "${WASI_SDK_PATH:-}" \
    "$HOME/.local/share/wasi-sdk" \
    "$HOME/.local/share"/wasi-sdk-* \
    /opt/homebrew/opt/wasi-sdk/share/wasi-sdk \
    /usr/local/opt/wasi-sdk/share/wasi-sdk \
    /opt/wasi-sdk
  do
    if [ -n "${path}" ] && [ -x "${path}/bin/clang" ]; then
      printf '%s\n' "${path}"
      return 0
    fi
  done
  return 1
}

SOURCE=""
OUTPUT=""
INCLUDES=()
CFLAGS_EXTRA=()
LDFLAGS_EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --include) INCLUDES+=("$2"); shift 2 ;;
    --cflag) CFLAGS_EXTRA+=("$2"); shift 2 ;;
    --ldflag) LDFLAGS_EXTRA+=("$2"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "${SOURCE}" ] && [ -n "${OUTPUT}" ] || { usage; exit 2; }
WASI_ROOT="$(find_wasi_sdk)" || { echo "wasi-sdk not found" >&2; exit 1; }

CC="${WASI_ROOT}/bin/clang"
SYSROOT="${WASI_ROOT}/share/wasi-sysroot"

ARGS=(--sysroot="${SYSROOT}" --target=wasm32-wasip1 -O2 -std=c11)
for inc in "${INCLUDES[@]}"; do ARGS+=(-I"${inc}"); done
ARGS+=("${CFLAGS_EXTRA[@]}")
ARGS+=(-o "${OUTPUT}" "${SOURCE}")
ARGS+=("${LDFLAGS_EXTRA[@]}")

exec "${CC}" "${ARGS[@]}"
```

- [ ] **Step 3: Document the harness for recipe authors**

```md
# packages/c-builder/README.md

The codepod C builder is a host-side, maturin-like builder around `clang` from `wasi-sdk`.

- It is not a compiler in WASI.
- It discovers `wasi-sdk`, sets `--target=wasm32-wasip1`, and applies recipe-provided include paths and flags.
- Recipes stay responsible for source fetching, patching, and config generation.
- The builder is responsible for reproducible compiler invocation and shared packaging conventions.
```

- [ ] **Step 4: Migrate the canary build to the shared harness**

```make
# packages/c-compat/Makefile
BUILD = ../../scripts/build-c-port.sh

stdio-canary.wasm: examples/stdio_canary.c include/codepod_compat.h src/codepod_runtime.h
	$(BUILD) --source examples/stdio_canary.c --output $@ --include include

sleep-canary.wasm: examples/sleep_canary.c include/codepod_compat.h src/codepod_runtime.h
	$(BUILD) --source examples/sleep_canary.c --output $@ --include include

system-canary.wasm: examples/system_canary.c src/codepod_command.c include/codepod_compat.h src/codepod_runtime.h
	$(BUILD) --source src/codepod_command.c --output build/codepod_command.o --include include --cflag -c
	$(BUILD) --source examples/system_canary.c --output build/system_canary.o --include include --cflag -c
	"$(shell ../../scripts/build-c-port.sh --help >/dev/null 2>&1; printf ../../scripts/build-c-port.sh)" --source /dev/null --output /dev/null
```

- [ ] **Step 5: Keep the simple canary wrapper script, but make it delegate to the harness**

```bash
# scripts/build-c-compat.sh
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/packages/c-compat"
make "${1:-all}"
```

- [ ] **Step 6: Document the harness in the command guide and C compatibility README**

```md
Add to `docs/guides/creating-commands.md`:

## Building C executables

For C programs, use the host-side builder in `scripts/build-c-port.sh`.

- The builder wraps `clang` from `wasi-sdk`; codepod does not provide an in-sandbox compiler.
- Plain file/stdio programs can target `wasm32-wasip1` directly.
- Command execution helpers such as `codepod_system()` and `codepod_popen()` are optional extensions, not part of baseline WASI.
- Shared libraries and full POSIX thread/process semantics are out of scope.
```

```md
Add to `packages/c-compat/README.md`:

- C builds are host-side cross-compiles driven by `scripts/build-c-port.sh`.
- Individual ports such as BusyBox live under `packages/c-ports/` and consume the builder.
```

- [ ] **Step 7: Validate the harness by rebuilding the canaries**

Run: `bash scripts/build-c-compat.sh copy-fixtures`

Expected: all canary `.wasm` files rebuild successfully through the harness path.

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/c-compat.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/c-builder/README.md scripts/build-c-port.sh scripts/build-c-compat.sh packages/c-compat/Makefile docs/guides/creating-commands.md packages/c-compat/README.md
git commit -m "feat: add host-side C/WASI builder"
```

### Task 4: Make BusyBox The First Recipe On Top Of The Harness

**Files:**
- Create: `packages/c-ports/busybox/Makefile`
- Create: `packages/c-ports/busybox/busybox.config`
- Create: `packages/c-ports/busybox/README.md`
- Create: `packages/c-ports/busybox/compat/include/paths.h`
- Modify: `packages/orchestrator/src/process/manager.ts`
- Modify: `packages/orchestrator/src/sandbox.ts`
- Modify: `docs/guides/package-manager.md`
- Modify: `docs/superpowers/specs/2026-04-19-c-abi-compatibility-design.md`
- Modify: `packages/c-compat/README.md`
- Modify: `packages/orchestrator/src/__tests__/c-compat.test.ts`
- Test: `packages/orchestrator/src/shell/__tests__/conformance/grep-busybox.test.ts`
- Test: `packages/orchestrator/src/shell/__tests__/conformance/head-busybox.test.ts`
- Test: `packages/orchestrator/src/shell/__tests__/conformance/seq-busybox.test.ts`

- [ ] **Step 1: Add a failing registration test for BusyBox-backed applets**

```ts
it('registers busybox applets as symlinked commands when busybox.wasm exists', async () => {
  const result = await sandbox.run('busybox grep foo /tmp/data.txt');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('foo');
});
```

- [ ] **Step 2: Create the BusyBox recipe on top of the harness**

```make
# packages/c-ports/busybox/Makefile
REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUILD := $(REPO_ROOT)/scripts/build-c-port.sh
BUSYBOX_URL := https://busybox.net/downloads/busybox-1.37.0.tar.bz2

.PHONY: all fetch configure build copy-fixtures clean

all: build/busybox.wasm

fetch:
	mkdir -p build src
	curl -L $(BUSYBOX_URL) | tar -xj -C src --strip-components=1

configure: fetch
	cp busybox.config src/.config
	cd src && yes "" | make oldconfig

build/busybox.wasm: configure
	$(MAKE) -C src CC=clang busybox
	cp src/busybox_unstripped build/busybox.wasm

copy-fixtures: build/busybox.wasm
	cp build/busybox.wasm $(FIXTURES)/busybox.wasm
```

- [ ] **Step 3: Carry the minimum known WASI compatibility shims into the recipe**

```config
# packages/c-ports/busybox/busybox.config
CONFIG_DESKTOP=n
CONFIG_LONG_OPTS=y
CONFIG_GREP=y
CONFIG_HEAD=y
CONFIG_SEQ=y
CONFIG_ASH=n
CONFIG_HUSH=n
CONFIG_FEATURE_PREFER_APPLETS=y
```

```c
/* packages/c-ports/busybox/compat/include/paths.h */
#ifndef _PATHS_H
#define _PATHS_H
#define _PATH_DEV "/dev/"
#define _PATH_BSHELL "/bin/sh"
#endif
```

- [ ] **Step 4: Register `busybox.wasm` plus selected applet symlinks**

```ts
mgr.registerTool('busybox', resolve(FIXTURES, 'busybox.wasm'));
mgr.registerMulticallTool?.('busybox', ['grep', 'head', 'seq']);
```

- [ ] **Step 5: Clarify package-manager and spec language**

```md
Add to `docs/guides/package-manager.md`:

- `pkg` installs standalone WASM executables regardless of implementation language.
- Supported C-compiled tools are packaged the same way as Rust-built tools.
- Multi-call binaries such as BusyBox may expose multiple commands through symlinks to a single installed WASM tool.

Update `docs/superpowers/specs/2026-04-19-c-abi-compatibility-design.md` to say:

- phase 1 now standardizes a host-side, maturin-like builder around `clang` / `wasi-sdk`
- BusyBox is the first recipe target on top of that harness
- no claim is made that codepod can compile C code inside WASI itself
```

- [ ] **Step 6: Add a concise phase summary to the C compatibility README**

```md
## Phase 1 delivered

- `stdio-canary`
- `sleep-canary`
- `system-canary`
- `popen-canary`
- host-side, maturin-like `clang` / `wasi-sdk` builder
- BusyBox recipe scaffolding

## Deferred

- socket libc shims
- `fork()` / `exec()` semantics
- portable `pthread` guarantees
- in-sandbox C compilation
```

- [ ] **Step 7: Build BusyBox and rerun the targeted tests**

Run: `cd packages/c-ports/busybox && make copy-fixtures`

Expected: `busybox.wasm` is built and copied into fixtures.

Run: `source scripts/dev-init.sh && deno test -A --no-check packages/orchestrator/src/__tests__/c-compat.test.ts packages/orchestrator/src/shell/__tests__/conformance/grep-busybox.test.ts packages/orchestrator/src/shell/__tests__/conformance/head-busybox.test.ts packages/orchestrator/src/shell/__tests__/conformance/seq-busybox.test.ts`

Expected: PASS for the canaries plus the selected BusyBox conformance suites.

- [ ] **Step 8: Commit**

```bash
git add packages/c-ports/busybox/Makefile packages/c-ports/busybox/busybox.config packages/c-ports/busybox/compat/include/paths.h packages/c-ports/busybox/README.md packages/orchestrator/src/process/manager.ts packages/orchestrator/src/sandbox.ts docs/guides/package-manager.md docs/superpowers/specs/2026-04-19-c-abi-compatibility-design.md packages/c-compat/README.md packages/orchestrator/src/platform/__tests__/fixtures/busybox.wasm packages/orchestrator/src/__tests__/c-compat.test.ts
git commit -m "feat: add BusyBox recipe on top of the C cross-builder harness"
```

---

## Self-Review

### Spec coverage

- Base `wasi-libc` + standalone executable model: covered by Task 1 and Task 3.
- First explicit extension API (`system()` / `popen()`-class behavior): covered by Task 2.
- Host-side, maturin-like builder around `clang` / `wasi-sdk`: covered by Task 3.
- Honest separation between baseline WASI and codepod extensions: covered by Task 2 and Task 4.
- Thread/sockets/shared-library non-goals: preserved in Task 4 documentation updates.
- First “real recipe” grounding: covered by the BusyBox pilot in Task 4.

### Placeholder scan

- No `TODO` / `TBD` markers remain.
- Every task names exact file paths.
- Every code-changing step includes concrete code or exact text to add.
- Every verification step includes an exact command and expected result.

### Type consistency

- Public API names are consistent across tasks: `codepod_system`, `codepod_popen`, `codepod_pclose`.
- The low-level import name is consistent with the current runtime: `host_run_command`.
- The test file path remains consistent across tasks: `packages/orchestrator/src/__tests__/c-compat.test.ts`.
