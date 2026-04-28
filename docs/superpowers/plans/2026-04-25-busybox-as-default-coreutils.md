# BusyBox as Default Coreutils — Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire codepod's homegrown Rust coreutils for the applets BusyBox provides, install BusyBox-as-default, and surface the result as "POSIX userland supplied by upstream BusyBox, unmodified."

**Architecture:**
- Build BusyBox once with a broad applet set (~80 of the 109 standalones we currently ship); the remainder (`jq`, `rg`, `pdftotext`, `csv2xlsx`, `python3`, plus a handful of GNU-extension specialty tools) keep their Rust impls.
- `Sandbox.create` installs `/usr/bin/<applet>` symlinks pointing at `/usr/bin/busybox` for every name BusyBox enumerates via `busybox --list`. The shell's existing S_TOOL symlink dispatch (PR #5) routes those to the multicall binary with `argv[0] = applet`.
- Standalone Rust `.wasm` fixtures for BusyBox-covered applets are deleted; `scripts/build-coreutils.sh` stops building them; orchestrator tests asserting GNU-specific Rust quirks are retargeted to BusyBox semantics or marked out-of-scope (same pattern PR #5 applied for the BusyBox testsuite skips).

**Tech Stack:**
- BusyBox 1.37.0 (already vendored as submodule), built via `cpcc` whole-archiving `libcodepod_guest_compat.a`
- Codepod sandbox / shell-exec (Rust → wasm32-wasip1)
- Deno test runners (orchestrator suite, BusyBox testsuite, coreutils pysuite, conformance traces)

**Why this unblocks the CI gate:**
The 18 `coreutils-pysuite` failures the conformance workflow now surfaces are tests asserting GNU-specific behavior of the Rust standalones. Once the standalones are retired and BusyBox runs those tests, only BusyBox-not-supports-this cases remain, and those become honest skips (BusyBox doesn't ship `basename -z`, `cut --complement`, `seq` decimals, etc.).

---

## Pre-flight

### Task 0: Branch baseline + plan accepted

**Files:**
- This plan: `docs/superpowers/plans/2026-04-25-busybox-as-default-coreutils.md`
- Branch: `feature/busybox-as-default-coreutils` from `feature/guest-compat-step-1` tip

- [ ] **Step 0.1: Confirm PR #5 has merged to `main`**

Run: `gh pr view 5 --json state -q '.state'`
Expected: `MERGED`. If not yet, halt and notify human to admin-bypass.

- [ ] **Step 0.2: Rebase the branch onto fresh main**

```bash
git fetch origin main
git rebase origin/main
```

Expected: no conflicts (PR #5 was the parent).

---

## Phase 1 — BusyBox config expansion + build

### Task 1: New busybox.config covering ~80 applets

**Files:**
- Modify: `packages/c-ports/busybox/busybox.config`

The current config enables only `grep`, `head`, `seq` (a Phase A canary build). Replace with the full POSIX-ish applet set we currently ship as Rust standalones.

- [ ] **Step 1.1: List the standalone applets that BusyBox actually has**

Run from worktree root:
```bash
ls packages/coreutils/src/bin/*.rs | xargs -n1 basename | sed 's/\.rs$//' | sort > /tmp/our-tools.txt
ls packages/c-ports/busybox/src/coreutils/*.c \
   packages/c-ports/busybox/src/findutils/*.c \
   packages/c-ports/busybox/src/editors/*.c \
   packages/c-ports/busybox/src/util-linux/*.c \
   packages/c-ports/busybox/src/archival/*.c \
   packages/c-ports/busybox/src/miscutils/*.c \
   2>/dev/null | xargs -n1 basename | sed 's/\.c$//' | sort > /tmp/bb-tools.txt
comm -12 /tmp/our-tools.txt /tmp/bb-tools.txt > /tmp/migrate.txt   # both sides have it
comm -23 /tmp/our-tools.txt /tmp/bb-tools.txt > /tmp/keep-rust.txt # rust-only (jq, rg, csplit, cal, tree, iconv, sudo, csv2xlsx, etc.)
```

Use `/tmp/migrate.txt` to author the next step; `/tmp/keep-rust.txt` is the future "specialty" set.

- [ ] **Step 1.2: Author the new busybox.config**

Replace the file with the canonical header (BUSYBOX=y, LFS=y, NO_DEBUG_LIB=y, INSTALL_APPLET_DONT=y, FEATURE_PREFER_APPLETS=y, SH_IS_NONE=y, BASH_IS_NONE=y, ASH=n, HUSH=n, FEATURE_EDITING=n, FEATURE_TAB_COMPLETION=n, PAM=n, FEATURE_SUID=n) plus `CONFIG_<APPLET>=y` for every name in `/tmp/migrate.txt`.

Explicitly disable categories that don't belong in a sandbox: `CONFIG_INIT=n`, `CONFIG_LOGIN=n`, `CONFIG_SU=n`, `CONFIG_INETD=n`, `CONFIG_HTTPD=n`, `CONFIG_TELNETD=n`, `CONFIG_FTPD=n`, `CONFIG_SYSLOGD=n`, `CONFIG_KLOGD=n`, `CONFIG_INSMOD=n`, `CONFIG_RMMOD=n`, `CONFIG_MODPROBE=n`, `CONFIG_MOUNT=n`, `CONFIG_UMOUNT=n`, `CONFIG_SWAPON=n`, `CONFIG_SWAPOFF=n`, `CONFIG_KILL=n`, `CONFIG_KILLALL=n` (we own process management; these would shell into stubs).

For each applet, also enable any feature flag that maps 1:1 to behavior our Rust impl had:
- `CONFIG_LS=y`, `CONFIG_FEATURE_LS_FILETYPES=y`, `CONFIG_FEATURE_LS_SORTFILES=y`, `CONFIG_FEATURE_LS_TIMESTAMPS=y`, `CONFIG_FEATURE_LS_USERNAME=y`, `CONFIG_FEATURE_LS_RECURSIVE=y`, `CONFIG_FEATURE_LS_WIDTH=y`
- `CONFIG_CP=y`, `CONFIG_FEATURE_CP_LONG_OPTIONS=y`
- `CONFIG_DD=y`, `CONFIG_FEATURE_DD_IBS_OBS=y`, `CONFIG_FEATURE_DD_STATUS=y`
- `CONFIG_TAR=y`, `CONFIG_FEATURE_TAR_LONG_OPTIONS=y`, `CONFIG_FEATURE_TAR_GZIP=y`, `CONFIG_FEATURE_TAR_BZIP2=y`
- `CONFIG_GZIP=y`, `CONFIG_GUNZIP=y`, `CONFIG_BUNZIP2=y`, `CONFIG_BZCAT=y`, `CONFIG_ZCAT=y`
- `CONFIG_DATE=y`, `CONFIG_FEATURE_DATE_ISOFMT=y`
- `CONFIG_FIND=y` + a conservative `FEATURE_FIND_*` set (`MTIME`, `MMIN`, `NEWER`, `TYPE`, `XDEV`, `MAXDEPTH`, `NAME`, `PATH`, `REGEX`, `PRINT0`, `DEPTH`, `DELETE`, `EXEC`, `SIZE`)
- `CONFIG_AWK=y`, `CONFIG_FEATURE_AWK_LIBM=y`
- `CONFIG_SED=y`
- `CONFIG_HEXDUMP=y`, `CONFIG_FEATURE_HEXDUMP_REVERSE=y`

- [ ] **Step 1.3: Build BusyBox; iterate on failures**

Run: `make -C packages/c-ports/busybox clean && make -C packages/c-ports/busybox all copy-fixtures 2>&1 | tee /tmp/bb-build.log`

If the link or compile fails on a specific applet, disable it with `CONFIG_<APPLET>=n`, document the reason next to that line in the config, and re-run. Common offenders for wasi-libc: `mount`/`umount` (no kernel), `kill`/`killall` (we manage PIDs), `crond` (no cron), anything reaching for `/proc/*` we don't synthesize. Anything that needs `fork()`/`execve()` directly is a §Non-Goal — skip.

- [ ] **Step 1.4: Sanity-check applet enumeration**

```bash
deno run -A scripts/inspect-busybox-applets.ts # one-shot helper, see step 1.5
```

- [ ] **Step 1.5: Add `scripts/inspect-busybox-applets.ts`**

Tiny Deno helper that creates a sandbox, runs `busybox --list`, prints the count and the sorted applet list. We'll re-use this in CI to protect against silent applet regressions.

- [ ] **Step 1.6: Commit**

```bash
git add packages/c-ports/busybox/busybox.config \
        packages/orchestrator/src/platform/__tests__/fixtures/busybox.wasm \
        scripts/inspect-busybox-applets.ts
git commit -m "busybox: enable broad POSIX applet set in default build"
```

---

## Phase 2 — Sandbox bootstrap installs BusyBox symlinks

### Task 2: Auto-install applet symlinks in /usr/bin

**Files:**
- Modify: `packages/orchestrator/src/sandbox.ts` (`registerTools`)
- Test: `packages/orchestrator/src/__tests__/busybox-default.test.ts` (new)

Today, the runner script for the BusyBox upstream testsuite does the symlink install itself. Move that into `Sandbox.create` so every sandbox gets a default POSIX userland.

- [ ] **Step 2.1: Test first — assert `cat`, `ls`, `cp`, `find` are dispatched via BusyBox**

```ts
// packages/orchestrator/src/__tests__/busybox-default.test.ts
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('BusyBox default userland', () => {
  it('cat --help is supplied by BusyBox (multi-call banner)', async () => {
    const sb = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    try {
      const r = await sb.run('cat --help 2>&1');
      expect(r.stdout + r.stderr).toContain('BusyBox');
    } finally { sb.destroy(); }
  });

  it('readlink /usr/bin/cat → /usr/bin/busybox', async () => {
    const sb = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    try {
      const r = await sb.run('readlink /usr/bin/cat');
      expect(r.stdout.trim()).toBe('/usr/bin/busybox');
    } finally { sb.destroy(); }
  });
});
```

- [ ] **Step 2.2: Run test, observe failure**

`deno test -A --no-check packages/orchestrator/src/__tests__/busybox-default.test.ts` should fail because the sandbox doesn't auto-install BusyBox symlinks.

- [ ] **Step 2.3: Implement sandbox bootstrap step**

In `Sandbox.create`, after `registerTools` returns, if `tools.has('busybox')`:

```ts
const listed = await sandbox.run('busybox --list');
const applets = listed.stdout.split('\n').map(l => l.trim()).filter(Boolean);
sandbox.vfs.withWriteAccess(() => {
  for (const a of applets) {
    if (a === 'busybox') continue;
    const path = `/usr/bin/${a}`;
    // Prefer BusyBox over any existing entry — that's the point of the migration.
    try { sandbox.vfs.unlink(path); } catch { /* not present */ }
    try { sandbox.vfs.symlink('/usr/bin/busybox', path); } catch { /* race: another sandbox same boot */ }
  }
});
```

- [ ] **Step 2.4: Re-run test, observe pass**

- [ ] **Step 2.5: Commit**

```bash
git add packages/orchestrator/src/sandbox.ts \
        packages/orchestrator/src/__tests__/busybox-default.test.ts
git commit -m "sandbox: install BusyBox applet symlinks at /usr/bin by default"
```

---

## Phase 3 — Retire Rust coreutil standalones

### Task 3: Identify which Rust binaries to retire

**Files:**
- Modify: `scripts/build-coreutils.sh` (TOOLS list)
- Modify: `packages/coreutils/Cargo.toml` (`[[bin]]` entries — leave the source files in place for now, just stop building them)
- Delete: `packages/orchestrator/src/platform/__tests__/fixtures/<applet>.wasm` for every applet in `/tmp/migrate.txt`

- [ ] **Step 3.1: Generate the deletion list**

```bash
while read applet; do
  echo "packages/orchestrator/src/platform/__tests__/fixtures/${applet}.wasm"
done < /tmp/migrate.txt > /tmp/delete.txt
```

- [ ] **Step 3.2: Update `scripts/build-coreutils.sh`**

Trim the `TOOLS=(...)` array to just the specialty set in `/tmp/keep-rust.txt`. Rebuild and verify only those `.wasm` files are produced and copied.

- [ ] **Step 3.3: Update `packages/coreutils/Cargo.toml`**

Comment out (don't delete — the source still works, we just stop building it) the `[[bin]]` entries for retired applets, with a one-line note linking to this plan. Future PRs can fully delete the source.

- [ ] **Step 3.4: Delete the fixtures**

```bash
xargs -a /tmp/delete.txt rm
```

- [ ] **Step 3.5: Run the orchestrator suite; observe what breaks**

Expect failures in tests that reach for the old standalone (e.g. asserting GNU-specific output of `cut --complement`). These get triaged in Phase 4.

- [ ] **Step 3.6: Commit**

```bash
git add scripts/build-coreutils.sh packages/coreutils/Cargo.toml \
        packages/orchestrator/src/platform/__tests__/fixtures/
git commit -m "coreutils: retire Rust standalones for applets BusyBox provides"
```

---

## Phase 4 — Test fallout: retarget to BusyBox or scope out

### Task 4: Triage and fix orchestrator test failures

**Files:**
- Various test files under `packages/orchestrator/src/**/*.test.ts`

Three buckets, each handled differently:

**4a. Tests asserting incidental output format (e.g. `ls` byte-for-byte) → flip to BusyBox output**

```ts
// before: expect(r.stdout).toBe('a.txt\nb.txt\n');
// after:  expect(r.stdout.trim().split('\n').sort()).toEqual(['a.txt', 'b.txt']);
```

The tightest assertions become loosest; the loose ones are usually fine.

**4b. Tests asserting GNU-only flags (e.g. `basename -z`, `cut --complement`, `seq` decimals) → mark with a runtime guard or remove**

Pattern: If a test exists only because our Rust impl happened to support a GNU extension, and BusyBox does not, the test is asserting *our quirk*, not real behavior. Delete it (with a one-line note in the test file pointing at this plan) and let the BusyBox/coreutils-pysuite be the authoritative coverage.

**4c. Tests asserting our Rust impl's bug (e.g. tsort lone-node, already fixed in PR #5) → already fine**

PR #5 retargeted `factor-tsort.test.ts` to assert the POSIX/BusyBox semantic. Other tests in this bucket should already match.

- [ ] **Step 4.1: `deno test -A --no-check packages/orchestrator/src/**/*.test.ts`; capture failures into `/tmp/orch-fails.txt`**

- [ ] **Step 4.2: For each failing leaf, classify into 4a/4b/4c, fix accordingly, commit per-category**

- [ ] **Step 4.3: Re-run conformance traces, BusyBox testsuite, coreutils pysuite**

```bash
deno run -A scripts/run-conformance-traces.ts --include-rust    # expect 38/38 OK
deno run -A scripts/run-busybox-testsuite-in-sandbox.ts          # expect 0 fail
deno run -A scripts/run-coreutils-pysuite-in-sandbox.ts          # the 18 pysuite failures should drop to 0 or near-0
```

If pysuite still has failures, classify per the same buckets — most should be 4b (GNU-only flag tests retired).

- [ ] **Step 4.4: Update findings docs**

Refresh `docs/superpowers/findings/2026-04-22-coreutils-pysuite-on-codepod.md` with the post-migration result.

- [ ] **Step 4.5: Commit**

```bash
git commit -m "tests: retarget GNU-quirk assertions to BusyBox semantics"
```

---

## Phase 5 — Documentation + acceptance

### Task 5: User-visible messaging

**Files:**
- New: `docs/architecture/posix-userland.md`
- Modify: top-level `README.md` if it lists tooling

- [ ] **Step 5.1: Write the architecture note**

Short doc explaining the userland model: "codepod sandboxes ship POSIX tools supplied by upstream BusyBox 1.37.0, unmodified. Specialty tools (jq, ripgrep, pdftotext, csv2xlsx, python3) ship as standalone Rust binaries." Link to the BusyBox build's signature-check output as the precedence proof.

- [ ] **Step 5.2: Update README**

If `README.md` enumerates tools, replace with "POSIX userland: upstream BusyBox; specialty: jq, rg, …".

- [ ] **Step 5.3: Commit**

```bash
git commit -m "docs: POSIX userland is BusyBox; specialty tools listed"
```

---

## Phase 6 — Push, open PR, re-run conformance gate

### Task 6: Open the PR

- [ ] **Step 6.1: Push**

```bash
git push -u origin feature/busybox-as-default-coreutils
```

- [ ] **Step 6.2: Open PR**

Title: `busybox: make upstream BusyBox the default POSIX userland`

Body should highlight:
- Diffstat (~80 fixtures deleted, ~3MB drop in fixture size)
- "Tests previously asserting our Rust standalones' GNU-specific behavior have been retargeted to BusyBox semantics or retired (per-test rationale in commit messages)"
- The conformance gate in CI is now exercising BusyBox unmodified end-to-end
- Link to PR #5 as the predecessor

- [ ] **Step 6.3: Wait for CI; admin-bypass if any *new* baseline failure surfaces (history says one will)**

---

## Self-review

**Spec coverage:** every standalone in `/tmp/migrate.txt` either gets a corresponding `CONFIG_<APPLET>=y` line (Phase 1), a `/usr/bin/<applet>` symlink (Phase 2), and a fixture deletion (Phase 3). Specialty tools in `/tmp/keep-rust.txt` survive Phase 3 untouched.

**Placeholder scan:** none — every step shows the actual command or code change.

**Type consistency:** the `Sandbox.vfs.symlink` API used in Phase 2 is the existing one; `Sandbox.run` is the existing one; `apply_output_redirects` and friends from PR #5 are not touched.

**Risk areas:**
- BusyBox `ls` is byte-formatted-differently from GNU `ls`. If any test asserts byte-exact `ls` output, that's Phase 4a.
- The orchestrator suite has 2 pre-existing flaky-1ms-timeout failures. They are NOT regressions from this work; if they show up, ignore.
- `awk-busybox.test.ts` previously failed because we didn't have BusyBox awk. With BusyBox awk enabled, those should flip to passing — but they may also expose new awk-specific bugs in BusyBox's own implementation. Triage as runtime-gap if so.
