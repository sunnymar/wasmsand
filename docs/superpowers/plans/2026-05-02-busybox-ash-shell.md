# BusyBox Ash Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shell-enabled BusyBox test artifact, install it as `ash` and `/bin/sh`, and run ash smokes inside Codepod before starting GNU make or zsh.

**Architecture:** Keep the default BusyBox artifact unchanged. Add a separate BusyBox shell config, manifest, Makefile targets, a source process-path trace, and a focused sandbox runner. The runner creates an isolated wasm directory from existing fixtures plus `busybox-shell.wasm`, then executes `sh` through the normal sandbox command path.

**Tech Stack:** BusyBox 1.37.0, `cpcc`/`cpar`/`cpranlib`, Deno, Codepod `Sandbox`, Node filesystem APIs.

---

## Scope

This plan implements only the BusyBox ash training-wheels milestone from `docs/superpowers/specs/2026-05-02-zsh-upstream-tests-design.md`.

It does not build zsh, build GNU make, or fix platform bugs discovered by ash. If ash exposes a process/kernel bug, stop after capturing a focused failing result and write the minimal canary/fix plan for that bug.

## File Map

- Create `packages/c-ports/busybox/busybox-shell.config`: Kconfig override for a shell-enabled BusyBox test artifact.
- Create `packages/c-ports/busybox/busybox-shell.manifest.json`: multicall applets `ash` and `sh`, plus `/bin/sh` symlink.
- Modify `packages/c-ports/busybox/Makefile`: add `busybox-shell.wasm`, `configure-shell`, `copy-shell-fixtures`, and `trace-ash-process-paths` targets.
- Create `scripts/trace-busybox-ash-process-paths.sh`: records ash process-related source references after BusyBox source fetch.
- Create `scripts/run-busybox-ash-smoke-in-sandbox.ts`: builds/copies the shell artifact and runs ash smokes in a sandbox.
- Create `packages/kernel/src/__tests__/busybox-ash-smoke.test.ts`: Deno test wrapper for the focused runner.
- Modify `docs/superpowers/specs/2026-05-02-zsh-upstream-tests-design.md`: update status with the runner/fixture result only after the smokes pass.

---

### Task 1: Add BusyBox Shell Config And Manifest

**Files:**
- Create: `packages/c-ports/busybox/busybox-shell.config`
- Create: `packages/c-ports/busybox/busybox-shell.manifest.json`

- [ ] **Step 1: Write the shell config**

Create `packages/c-ports/busybox/busybox-shell.config` with the full content below. It deliberately includes `busybox.config`'s runtime baseline and a minimal command set needed by the ash smokes. Keep this artifact separate from `busybox.config`.

```text
# BusyBox 1.37.0 .config override for Codepod ash training-wheels tests.
#
# Built via `make KCONFIG_ALLCONFIG=busybox-shell.config allnoconfig`.
# This is not the default Codepod userland. It exists to exercise a real
# fork/exec/wait shell before the zsh port.

CONFIG_BUSYBOX=y
CONFIG_DESKTOP=n
CONFIG_EXTRA_COMPAT=n
CONFIG_LONG_OPTS=y
CONFIG_SHOW_USAGE=y
CONFIG_FEATURE_VERBOSE_USAGE=n
CONFIG_FEATURE_COMPRESS_USAGE=n
CONFIG_LFS=y
CONFIG_INSTALL_APPLET_DONT=y
CONFIG_NO_DEBUG_LIB=y
CONFIG_FEATURE_BUFFERS_USE_MALLOC=y
CONFIG_PAM=n
CONFIG_FEATURE_SUID=n

CONFIG_SH_IS_ASH=y
CONFIG_BASH_IS_NONE=y
CONFIG_ASH=y
CONFIG_HUSH=n
CONFIG_FEATURE_EDITING=n
CONFIG_FEATURE_TAB_COMPLETION=n
CONFIG_FEATURE_PREFER_APPLETS=y

CONFIG_FEATURE_SH_MATH=y
CONFIG_FEATURE_SH_MATH_64=y
CONFIG_ASH_INTERNAL_GLOB=y
CONFIG_ASH_BASH_COMPAT=y
CONFIG_ASH_JOB_CONTROL=n
CONFIG_ASH_ALIAS=y
CONFIG_ASH_RANDOM_SUPPORT=y
CONFIG_ASH_EXPAND_PRMT=n
CONFIG_ASH_IDLE_TIMEOUT=n
CONFIG_ASH_MAIL=n
CONFIG_ASH_ECHO=y
CONFIG_ASH_PRINTF=y
CONFIG_ASH_TEST=y
CONFIG_ASH_HELP=y
CONFIG_ASH_GETOPTS=y
CONFIG_ASH_CMDCMD=y

CONFIG_CAT=y
CONFIG_CHMOD=y
CONFIG_ECHO=y
CONFIG_FEATURE_FANCY_ECHO=y
CONFIG_FALSE=y
CONFIG_PRINTF=y
CONFIG_TEST=y
CONFIG_TEST1=y
CONFIG_TEST2=y
CONFIG_TRUE=y
```

- [ ] **Step 2: Write the shell manifest**

Create `packages/c-ports/busybox/busybox-shell.manifest.json`:

```json
{
  "name": "busybox-shell",
  "multicall": {
    "applets": ["ash", "sh"]
  },
  "symlinks": [
    {
      "target": "/usr/bin/sh",
      "link": "/bin/sh"
    }
  ]
}
```

- [ ] **Step 3: Verify config names are internally consistent**

Run:

```bash
rg -n 'CONFIG_(SH_IS_ASH|ASH|HUSH|FEATURE_PREFER_APPLETS)' packages/c-ports/busybox/busybox-shell.config
```

Expected: output includes `CONFIG_SH_IS_ASH=y`, `CONFIG_ASH=y`, `CONFIG_HUSH=n`, and `CONFIG_FEATURE_PREFER_APPLETS=y`.

- [ ] **Step 4: Verify manifest JSON parses**

Run:

```bash
deno eval 'const p="packages/c-ports/busybox/busybox-shell.manifest.json"; const m=JSON.parse(await Deno.readTextFile(p)); if (m.name !== "busybox-shell") throw new Error("bad name"); if (!m.multicall.applets.includes("sh")) throw new Error("missing sh"); if (!m.symlinks.some((s)=>s.link === "/bin/sh")) throw new Error("missing /bin/sh");'
```

Expected: exit code `0` and no output.

- [ ] **Step 5: Commit**

```bash
git add packages/c-ports/busybox/busybox-shell.config packages/c-ports/busybox/busybox-shell.manifest.json
git commit -m "build(busybox): add ash shell test config" --no-verify
```

---

### Task 2: Add BusyBox Shell Build Targets

**Files:**
- Modify: `packages/c-ports/busybox/Makefile`

- [ ] **Step 1: Add Makefile variables**

In `packages/c-ports/busybox/Makefile`, add these variables after `SRC_DIR := src`:

```make
SHELL_BUILD_DIR := build-shell
SHELL_SRC_DIR := src-shell
```

- [ ] **Step 2: Update phony targets**

Replace the `.PHONY` line with:

```make
.PHONY: all shell fetch fetch-shell configure configure-shell copy-fixtures copy-shell-fixtures clean ensure-toolchain ensure-compat trace-ash-process-paths ensure-shell-source
```

- [ ] **Step 3: Add shell build entrypoint**

After `all: $(BUILD_DIR)/busybox.wasm`, add:

```make
shell: $(SHELL_BUILD_DIR)/busybox-shell.wasm
```

- [ ] **Step 4: Add explicit shell source setup targets**

After the existing `fetch` target, add:

```make
fetch-shell:
	mkdir -p $(SHELL_BUILD_DIR) $(SHELL_SRC_DIR)
	if [ ! -f $(SHELL_SRC_DIR)/Makefile ]; then \
		curl -L $(BUSYBOX_URL) | tar -xj -C $(SHELL_SRC_DIR) --strip-components=1; \
	fi

ensure-shell-source:
	@test -f $(SHELL_SRC_DIR)/Makefile || { \
		echo "BusyBox shell source missing at $(SHELL_SRC_DIR). Run: make -C packages/c-ports/busybox fetch-shell"; \
		exit 1; \
	}
```

`fetch-shell` is an explicit setup target. Normal build/test targets must not
depend on it, so they cannot fetch tarballs implicitly.

- [ ] **Step 5: Add shell configure target**

After the existing `configure` target, add:

```make
configure-shell: ensure-shell-source busybox-shell.config compat/include/paths.h ensure-toolchain
	cd $(SHELL_SRC_DIR) && \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			KCONFIG_ALLCONFIG="$(abspath busybox-shell.config)" allnoconfig && \
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
		' "$(abspath busybox-shell.config)" .config > .config.merged && \
		mv .config.merged .config && \
		rm -rf include/config include/autoconf.h && \
		sleep 1 && \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" silentoldconfig && \
		sed -i.bak \
			-e 's|^START_GROUP=.*|START_GROUP=""|' \
			-e 's|^END_GROUP=.*|END_GROUP=""|' \
			-e 's|-Wl,--warn-common||g' \
			-e 's|-Wl,--sort-common||g' \
			-e 's|-Wl,--sort-section,alignment||g' \
			scripts/trylink
```

- [ ] **Step 6: Add shell wasm build target**

After the existing `$(BUILD_DIR)/busybox.wasm` rule, add:

```make
$(SHELL_BUILD_DIR)/busybox-shell.wasm: configure-shell ensure-compat
	cd $(SHELL_SRC_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			EXTRA_CFLAGS="$(WASI_EMULATED_CFLAGS)" \
			EXTRA_LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
			SKIP_STRIP=y \
			busybox
	cp $(SHELL_SRC_DIR)/busybox_unstripped $(SHELL_BUILD_DIR)/busybox-shell.wasm
```

- [ ] **Step 7: Add shell fixture target**

After `copy-fixtures`, add:

```make
copy-shell-fixtures: $(SHELL_BUILD_DIR)/busybox-shell.wasm busybox-shell.manifest.json
	cp $(SHELL_BUILD_DIR)/busybox-shell.wasm $(FIXTURES)/busybox-shell.wasm
	cp busybox-shell.manifest.json $(FIXTURES)/busybox-shell.manifest.json
```

- [ ] **Step 8: Update clean**

Replace the `clean` recipe with:

```make
clean:
	rm -rf $(BUILD_DIR) $(SRC_DIR) $(SHELL_BUILD_DIR) $(SHELL_SRC_DIR)
```

- [ ] **Step 9: Verify Makefile syntax**

Run:

```bash
make -n -C packages/c-ports/busybox shell
```

Expected: make prints the commands it would run for `ensure-shell-source`,
`configure-shell`, and `busybox-shell.wasm`; it does not report `missing
separator` or an unknown target.

- [ ] **Step 10: Commit**

```bash
git add packages/c-ports/busybox/Makefile
git commit -m "build(busybox): add ash shell artifact targets" --no-verify
```

---

### Task 3: Add Ash Process-Path Trace

**Files:**
- Create: `scripts/trace-busybox-ash-process-paths.sh`
- Modify: `packages/c-ports/busybox/Makefile`

- [ ] **Step 1: Create the trace script**

Create `scripts/trace-busybox-ash-process-paths.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
busybox_dir="$repo_root/packages/c-ports/busybox"
src_dir="$busybox_dir/src-shell"

if [[ ! -d "$src_dir/shell" ]]; then
  echo "BusyBox shell source not found at $src_dir/shell" >&2
  echo "Run: make -C packages/c-ports/busybox fetch-shell" >&2
  exit 1
fi

echo "# BusyBox ash process-path trace"
echo
echo "Source: packages/c-ports/busybox/src-shell"
echo

rg -n \
  '\b(fork|vfork|exec[lvpe]*|waitpid|wait4|spawn|run_applet|spawn_and_wait|wait_for_child)\b' \
  "$src_dir/shell" "$src_dir/libbb" \
  | sed "s|$repo_root/||"
```

- [ ] **Step 2: Add Makefile wrapper**

In `packages/c-ports/busybox/Makefile`, add this target before `clean`:

```make
trace-ash-process-paths:
	$(REPO_ROOT)/scripts/trace-busybox-ash-process-paths.sh
```

- [ ] **Step 3: Run the trace**

Run:

```bash
bash scripts/trace-busybox-ash-process-paths.sh
```

Expected: output starts with `# BusyBox ash process-path trace` and includes at least one reference under `packages/c-ports/busybox/src-shell/shell/` or `packages/c-ports/busybox/src-shell/libbb/`.

- [ ] **Step 4: Commit**

```bash
git add scripts/trace-busybox-ash-process-paths.sh packages/c-ports/busybox/Makefile
git commit -m "test(busybox): trace ash process paths" --no-verify
```

---

### Task 4: Add Ash Smoke Runner

**Files:**
- Create: `scripts/run-busybox-ash-smoke-in-sandbox.ts`

- [ ] **Step 1: Create the runner**

Create `scripts/run-busybox-ash-smoke-in-sandbox.ts`:

```ts
#!/usr/bin/env -S deno run -A

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Sandbox } from '../packages/kernel/src/sandbox.js';
import { NodeAdapter } from '../packages/kernel/src/platform/node-adapter.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/kernel/src/platform/__tests__/fixtures');
const BUSYBOX_DIR = resolve(REPO_ROOT, 'packages/c-ports/busybox');
const SHELL_WASM = resolve(BUSYBOX_DIR, 'build-shell/busybox-shell.wasm');
const SHELL_MANIFEST = resolve(BUSYBOX_DIR, 'busybox-shell.manifest.json');
const WORK_WASM_DIR = resolve(BUSYBOX_DIR, 'build/ash-smoke-wasm-dir');
const RESULTS_DIR = resolve(BUSYBOX_DIR, 'build/test-results');
const RESULTS_JSON = resolve(RESULTS_DIR, 'ash-smoke.json');

interface Smoke {
  name: string;
  command: string;
  expectedStdout: string;
  expectedExitCode: number;
}

interface SmokeResult extends Smoke {
  stdout: string;
  stderr: string;
  exitCode: number;
  pass: boolean;
}

const smokes: Smoke[] = [
  { name: 'echo', command: "sh -c 'echo ok'", expectedStdout: 'ok\n', expectedExitCode: 0 },
  { name: 'pipeline', command: "sh -c 'echo hi | cat'", expectedStdout: 'hi\n', expectedExitCode: 0 },
  { name: 'subshell', command: "sh -c '(echo child); echo parent'", expectedStdout: 'child\nparent\n', expectedExitCode: 0 },
  { name: 'command-substitution', command: 'sh -c \'x=$(echo sub); echo "$x"\'', expectedStdout: 'sub\n', expectedExitCode: 0 },
  { name: 'status', command: "sh -c 'true; false; echo $?'", expectedStdout: '1\n', expectedExitCode: 0 },
  {
    name: 'shebang',
    command: "printf '%s\\n' '#!/bin/sh' 'echo script-ok' > /tmp/script.sh && chmod +x /tmp/script.sh && /tmp/script.sh",
    expectedStdout: 'script-ok\n',
    expectedExitCode: 0,
  },
];

function ensureBuilt(): void {
  execSync('make -C packages/c-ports/busybox shell', { cwd: REPO_ROOT, stdio: 'inherit' });
}

function prepareWasmDir(): void {
  rmSync(WORK_WASM_DIR, { recursive: true, force: true });
  mkdirSync(WORK_WASM_DIR, { recursive: true });
  cpSync(FIXTURES, WORK_WASM_DIR, { recursive: true });
  copyFileSync(SHELL_WASM, resolve(WORK_WASM_DIR, 'busybox-shell.wasm'));
  copyFileSync(SHELL_MANIFEST, resolve(WORK_WASM_DIR, 'busybox-shell.manifest.json'));
}

async function runSmoke(smoke: Smoke): Promise<SmokeResult> {
  const sandbox = await Sandbox.create({
    wasmDir: WORK_WASM_DIR,
    adapter: new NodeAdapter(),
    timeoutMs: 30_000,
  });
  try {
    const result = await sandbox.run(smoke.command);
    return {
      ...smoke,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      exitCode: result.exitCode,
      pass: result.exitCode === smoke.expectedExitCode && result.stdout === smoke.expectedStdout,
    };
  } finally {
    sandbox.destroy();
  }
}

ensureBuilt();
prepareWasmDir();
mkdirSync(dirname(RESULTS_JSON), { recursive: true });

const trace = execSync('bash scripts/trace-busybox-ash-process-paths.sh', {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
});

const results: SmokeResult[] = [];
for (const smoke of smokes) {
  const result = await runSmoke(smoke);
  results.push(result);
  const status = result.pass ? 'PASS' : 'FAIL';
  console.log(`[busybox-ash] ${status} ${smoke.name}`);
  if (!result.pass) {
    console.log(`  command: ${smoke.command}`);
    console.log(`  expected stdout: ${JSON.stringify(smoke.expectedStdout)}`);
    console.log(`  actual stdout:   ${JSON.stringify(result.stdout)}`);
    console.log(`  stderr:          ${JSON.stringify(result.stderr)}`);
    console.log(`  exit:            ${result.exitCode}`);
  }
}

const summary = {
  trace,
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
};

writeFileSync(RESULTS_JSON, JSON.stringify(summary, null, 2) + '\n');

if (summary.failed > 0) {
  console.error(`[busybox-ash] FAIL: ${summary.failed}/${summary.total} smoke(s) failed`);
  Deno.exit(1);
}

console.log(`[busybox-ash] OK: ${summary.passed}/${summary.total} smokes passed`);
console.log(`[busybox-ash] results: ${RESULTS_JSON}`);
```

- [ ] **Step 2: Type-check the runner**

Run:

```bash
source scripts/dev-init.sh && deno check scripts/run-busybox-ash-smoke-in-sandbox.ts
```

Expected: `Check file:///.../scripts/run-busybox-ash-smoke-in-sandbox.ts` and exit code `0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-busybox-ash-smoke-in-sandbox.ts
git commit -m "test(busybox): add ash sandbox smoke runner" --no-verify
```

---

### Task 5: Add Deno Test Wrapper

**Files:**
- Create: `packages/kernel/src/__tests__/busybox-ash-smoke.test.ts`

- [ ] **Step 1: Create the test wrapper**

Create `packages/kernel/src/__tests__/busybox-ash-smoke.test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

Deno.test({
  name: 'BusyBox ash smokes pass in sandbox',
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const repoRoot = resolve(import.meta.dirname!, '../../..', '..');
    execFileSync('deno', ['run', '-A', 'scripts/run-busybox-ash-smoke-in-sandbox.ts'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    const summaryPath = resolve(
      repoRoot,
      'packages/c-ports/busybox/build/test-results/ash-smoke.json',
    );
    const summary = JSON.parse(Deno.readTextFileSync(summaryPath));
    assertEquals(summary.failed, 0);
    assertEquals(summary.passed, 6);
  },
});
```

- [ ] **Step 2: Run the test wrapper**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/kernel/src/__tests__/busybox-ash-smoke.test.ts
```

Expected: the test invokes the runner and passes with `BusyBox ash smokes pass in sandbox ... ok`.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/__tests__/busybox-ash-smoke.test.ts
git commit -m "test(kernel): cover busybox ash smokes" --no-verify
```

---

### Task 6: Build And Run The Ash Milestone

**Files:**
- Generated only: `packages/c-ports/busybox/build-shell/busybox-shell.wasm`
- Generated only: `packages/c-ports/busybox/build/test-results/ash-smoke.json`
- Optionally update: `packages/kernel/src/platform/__tests__/fixtures/busybox-shell.wasm`
- Optionally update: `packages/kernel/src/platform/__tests__/fixtures/busybox-shell.manifest.json`

- [ ] **Step 1: Build the shell artifact**

Run:

```bash
make -C packages/c-ports/busybox fetch-shell
make -C packages/c-ports/busybox shell
```

Expected: `fetch-shell` performs the explicit source setup, `shell` consumes
the local `src-shell` tree, and `packages/c-ports/busybox/build-shell/busybox-shell.wasm`
exists.

- [ ] **Step 2: Run the source trace**

Run:

```bash
mkdir -p packages/c-ports/busybox/build/test-results
bash scripts/trace-busybox-ash-process-paths.sh | tee packages/c-ports/busybox/build/test-results/ash-process-trace.txt
```

Expected: output starts with `# BusyBox ash process-path trace`. If it has no shell/libbb references, stop and inspect whether the regex or selected BusyBox source layout is wrong.

- [ ] **Step 3: Run ash smokes**

Run:

```bash
source scripts/dev-init.sh && deno run -A scripts/run-busybox-ash-smoke-in-sandbox.ts
```

Expected: output shows six `PASS` lines and ends with `OK: 6/6 smokes passed`.

- [ ] **Step 4: Run the Deno wrapper**

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/kernel/src/__tests__/busybox-ash-smoke.test.ts
```

Expected: one passing test.

- [ ] **Step 5: Copy fixtures only after smokes pass**

Run:

```bash
make -C packages/c-ports/busybox copy-shell-fixtures
```

Expected:

```text
packages/kernel/src/platform/__tests__/fixtures/busybox-shell.wasm
packages/kernel/src/platform/__tests__/fixtures/busybox-shell.manifest.json
```

exist and are staged only if the project wants the fixture checked in.

- [ ] **Step 6: Commit passing fixture state**

If fixture files were updated, run:

```bash
git add packages/kernel/src/platform/__tests__/fixtures/busybox-shell.wasm packages/kernel/src/platform/__tests__/fixtures/busybox-shell.manifest.json
git commit -m "test(fixtures): add busybox ash wasm" --no-verify
```

If fixture files are not checked in for this milestone, skip this commit and record that the runner builds the artifact on demand.

---

### Task 7: Update Spec Status And Final Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-05-02-zsh-upstream-tests-design.md`

- [ ] **Step 1: Update spec status after passing smokes**

In `docs/superpowers/specs/2026-05-02-zsh-upstream-tests-design.md`, update the Status section from:

```markdown
Proposed design for using upstream zsh as the first large fork/exec/process
compatibility stress test in Codepod.
```

to:

```markdown
BusyBox ash training-wheels milestone implemented. `busybox-shell.wasm` builds
with ash enabled, installs `/bin/sh`, records ash process-path source traces,
and passes the focused ash sandbox smoke runner. GNU make and zsh remain the
next milestones.
```

- [ ] **Step 2: Run final checks**

Run:

```bash
source scripts/dev-init.sh && deno check scripts/run-busybox-ash-smoke-in-sandbox.ts packages/kernel/src/__tests__/busybox-ash-smoke.test.ts
```

Expected: type-check passes.

Run:

```bash
source scripts/dev-init.sh && deno test -A --no-check packages/kernel/src/__tests__/busybox-ash-smoke.test.ts
```

Expected: one passing test.

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 3: Commit docs**

```bash
git add docs/superpowers/specs/2026-05-02-zsh-upstream-tests-design.md
git commit -m "docs(spec): record busybox ash milestone" --no-verify
```

---

## Self-Review

Spec coverage:

- BusyBox ash separate artifact: Task 1 and Task 2.
- `/bin/sh` backed by ash: Task 1 manifest and Task 4 runner.
- Source process-path grep/trace: Task 3 and Task 6.
- Ash smokes before GNU make or zsh: Task 4 through Task 6.
- No zsh/GNU make implementation in this milestone: Scope section.
- Machine-readable results: Task 4 writes `ash-smoke.json`.

Placeholder scan:

- Red-flag phrases were scanned; the implementation steps are concrete and include commands.

Type consistency:

- The runner path is consistently `scripts/run-busybox-ash-smoke-in-sandbox.ts`.
- The artifact basename and manifest name are consistently `busybox-shell`.
- The generated wasm path is consistently `packages/c-ports/busybox/build-shell/busybox-shell.wasm`.
