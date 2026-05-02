# Zsh Upstream Tests On Codepod

## Status

Proposed design for using upstream zsh as the first large fork/exec/process
compatibility stress test in Codepod.

This spec assumes the Asyncify continuation fork work has landed. The goal is
not merely to run a few zsh commands. The goal is to build zsh for Codepod,
build enough userland to run its upstream test harness, and drive the upstream
`make check` path inside the sandbox.

## Problem

The fork canary proves the narrow continuation split works. It does not prove
that a real shell can survive the process behavior it expects:

- `fork()` in subshells, pipelines, command substitutions, and asynchronous
  command execution
- child-side `exec*()` preserving the observable process model expected by the
  parent shell
- inherited fd tables, shared open file descriptions, pipe EOF behavior, and
  redirection cleanup
- `waitpid()` and exit status propagation across many child processes
- enough external userland commands for a shell test suite to be meaningful

BusyBox ash is the first lower-risk shell target because Codepod already has a
BusyBox port and fixture runner. Enabling ash should expose the same general
fork, exec, wait, pipe, redirection, and command-substitution behavior with a
smaller fixture surface. Upstream zsh remains the larger integration target:
its own test harness is written in zsh and runs many small process,
redirection, substitution, and builtin cases. If ash can run shell smokes and
zsh can run its own tests in Codepod, the fork work is being tested against
substantially more realistic workloads.

## Sources

- Upstream zsh mirror: `https://github.com/zsh-users/zsh`
- Upstream zsh test docs: `https://github.com/zsh-users/zsh/blob/master/Test/README`
- Upstream zsh test make entrypoint: `https://github.com/zsh-users/zsh/blob/master/Test/Makefile.in`
- Upstream zsh install/build docs: `https://github.com/zsh-users/zsh/blob/master/INSTALL`
- GNU make upstream project: `https://www.gnu.org/software/make/`

The zsh upstream docs define `make check` / `make test` as the normal test
entrypoint and support `TESTNUM=<prefix>` for individual files or categories.
The `Test/Makefile.in` entrypoint runs `Src/zsh` with `Test/runtests.zsh` and
sets `ZTST_testlist`, `ZTST_srcdir`, and `ZTST_exe`.
It runs from the build `Test` directory and invokes zsh with `+Z -f`; the
fallback driver must preserve both the working directory and `+Z` behavior to
count as upstream-equivalent.

## Goals

1. Add a reproducible zsh C port under `packages/c-ports/zsh/`.
2. Build `zsh.wasm` through `cpcc` with continuation support enabled.
3. Add a BusyBox shell test variant that enables ash and installs `/bin/sh`.
4. Run ash shell smoke tests before attempting GNU make or zsh.
5. Add a richer BusyBox build or BusyBox variant that includes the external
   commands needed by the zsh test suite.
6. Make a serious attempt to build GNU make for Codepod and use it to drive
   zsh's upstream `make check` path inside the sandbox.
7. Run upstream zsh tests inside Codepod, using `TESTNUM` category slices for
   triage and a full-suite target for final acceptance.
8. Treat failures as platform findings: classify each as zsh port issue,
   BusyBox/userland gap, GNU make gap, guest-compat syscall gap, kernel process
   bug, or unsupported terminal/module feature.
9. Keep all source inputs pinned and reproducible.

## Non-Goals

- Implement WebAssembly dynamic linking for zsh modules in this slice.
- Claim full interactive terminal/ZLE parity before non-interactive tests are
  passing.
- Patch upstream zsh tests to make failing behavior disappear.
- Replace zsh's test harness with a hand-written smoke suite.
- Build an entire GNU/Linux userland. Only the commands needed to run zsh's
  tests are in scope.
- Use host-side execution as acceptance for zsh behavior. Host execution is
  allowed only during configure/build.

## Acceptance Definition

The primary acceptance target is real:

```sh
make check
```

running inside a Codepod sandbox against the Codepod-built `zsh.wasm`.

Final acceptance requires:

1. `zsh.wasm` is built from pinned upstream zsh source through `cpcc`.
2. The runtime starts zsh through the normal sandbox process path, not a custom
   host escape.
3. BusyBox ash is built as a continuation-enabled shell test artifact, installed
   as `/bin/sh`, and passes the ash smoke slice below.
4. The implementation records whether ash uses `fork`, `vfork`, `exec*`,
   `waitpid`, or BusyBox's shell-specific process helpers in the selected
   upstream source version. This source grep/trace is part of the acceptance
   evidence, not a substitute for running the shell.
5. The sandbox VFS contains the zsh build tree, `Src/zsh`, `Test/*.ztst`,
   `Test/runtests.zsh`, `Functions/`, `Completion/`, generated build-side
   files required by the selected test categories, and the external tools
   needed by the tests.
6. GNU make is used to invoke zsh's `make check` path unless the bounded make
   investigation reaches the explicit side-quest gate described below.
7. If GNU make becomes a disproportionate side quest, the implementation must
   stop and present evidence before switching to a direct `runtests.zsh` driver.
8. A direct driver, if approved, must run from the build `Test` directory,
   invoke `../Src/zsh +Z -f <source Test dir>/runtests.zsh` or the equivalent
   configured `dir_top`/`sdir` paths, and set the same essential environment as
   upstream `Test/Makefile.in`:

   ```text
   ZTST_testlist=<matching Test/*.ztst files>
   ZTST_srcdir=<Test source dir>
   ZTST_exe=<path to Codepod zsh>
   ```

9. Test results are persisted as machine-readable output and a human summary:
   passed, failed, skipped, timed out, and blocked.

## Upstream Source Policy

`packages/c-ports/zsh/upstream` must be a git submodule pinned to a specific
upstream commit or release tag. The implementation plan should prefer the
current stable upstream release if a tag is available; otherwise it may pin the
GitHub mirror's `master` commit and record the exact commit SHA in the port
README.

`packages/c-ports/make/upstream` should likewise be a git submodule or release
source pin. GNU make 4.4.1 is the likely first target because it is the latest
widely published GNU make release at the time of this spec, but the
implementation plan may update that if upstream publishes a newer stable release
before work begins.

No port may fetch tarballs during a normal build. Fetching or submodule
initialization is an explicit setup step; the build itself consumes pinned local
source.

## Zsh Build Strategy

Build zsh as a static Codepod executable:

```sh
CC=target/release/cpcc
AR=target/release/cpar
RANLIB=target/release/cpranlib
CPCC_USE_CONTINUATIONS=1
CPCC_ARCHIVE=packages/guest-compat/build/libcodepod_guest_compat.a
CPCC_CONTINUATIONS_ARCHIVE=packages/guest-compat/build/libcodepod_continuations.a
```

Configure should start conservative:

```sh
./configure \
  --host=wasm32-wasi \
  --prefix=/usr \
  --disable-dynamic \
  --disable-pcre \
  --disable-gdbm \
  --disable-cap \
  --disable-zsh-secure-free
```

Rationale:

- `--disable-dynamic` avoids Wasm dynamic module loading. Static modules are
  acceptable for this milestone.
- `pcre`, `gdbm`, and capabilities are optional zsh features and would add
  unrelated ports.
- The non-interactive shell core, parser, substitution engine, builtins,
  redirection, fork, exec, and wait behavior remain in scope.

The port may patch configure probes or provide cache answers only when the
answer describes Codepod's actual runtime behavior. For example, answering
`fork=yes` is only allowed after the continuation runtime is available to the
linked binary. Answering a terminal or job-control probe as available when the
kernel cannot support it is not allowed.

## BusyBox Ash Training-Wheels Strategy

The existing BusyBox port deliberately disables shell support:

```text
CONFIG_SH_IS_NONE=y
CONFIG_ASH=n
CONFIG_HUSH=n
```

Before the zsh port, this work must build a BusyBox shell test artifact that
enables ash and maps `/bin/sh` to ash. This is the first real shell process
exercise because it should require the same general continuation-backed
`fork`/`exec`/`waitpid` shape as zsh, but the project already has BusyBox build
scaffolding, a manifest model, and a sandbox testsuite runner.

The implementation should prefer a separate test artifact/config at first,
for example `busybox-shell.config` or `busybox-tests.config`, unless broadening
the default BusyBox artifact is explicitly accepted. Keeping the default
artifact unchanged avoids expanding the normal sandbox userland surface while
ash is still acting as a platform probe.

The BusyBox shell artifact must enable:

```text
CONFIG_ASH=y
CONFIG_SH_IS_ASH=y
```

and must install manifest entries or VFS links for both `ash` and `sh`.
`CONFIG_HUSH` is optional and should not block ash or zsh work; hush may be
added in a separate follow-up as a comparison shell if ash passes and the extra
coverage is useful.

After fetching the pinned BusyBox source, the implementation must inspect the
selected `shell/ash.c` and related BusyBox shell helpers for `fork`, `vfork`,
`exec*`, `waitpid`, and internal process helper usage. The report should state
which paths ash is expected to exercise in Codepod. The grep/trace is useful
for confidence, but acceptance still comes from running ash in the sandbox.
BusyBox shell source setup is an explicit setup step, not part of the normal
ash build/test command. `make shell` and the ash smoke runner must consume an
already-populated local source tree and fail with setup guidance if it is
missing.

Ash acceptance starts with:

```sh
sh -c 'echo ok'
sh -c 'echo hi | cat'
sh -c '(echo child); echo parent'
sh -c 'x=$(echo sub); echo "$x"'
sh -c 'true; false; echo $?'
printf '%s\n' '#!/bin/sh' 'echo script-ok' > /tmp/script.sh && chmod +x /tmp/script.sh && /tmp/script.sh
```

Failures in this slice should be classified before moving to GNU make. If ash
cannot pass a basic pipe, subshell, command substitution, or script shebang, the
implementation should add focused process/kernel canaries before attempting zsh.

## BusyBox Userland Strategy

Beyond ash, the existing BusyBox port is too narrow for zsh's test suite. This
work needs a test-support BusyBox build that includes at least:

```text
ash sh cat chmod cp cut diff dirname echo env expr false find grep head
ln ls mkdir mktemp mv printf pwd rm rmdir sed sleep sort tail test touch
tr true uname wc xargs
```

The implementation may either:

1. Broaden the existing `packages/c-ports/busybox` config, or
2. Add a separate `busybox-tests` build artifact and manifest.

The second option is safer if broadening BusyBox would risk changing the default
sandbox command set. In either case, the zsh test sandbox must install applet
symlinks so commands such as `diff`, `tail`, and `chmod` resolve naturally.
It must also install `/bin/sh` as the BusyBox ash applet for GNU make recipe
execution. Overriding GNU make's `SHELL` is allowed only as an explicitly
reported experiment; the acceptance path must prove that a guest `/bin/sh`
exists and no recipe executes through a host shell.

If a zsh test uses a command not in the initial list, the runner must report it
as a missing userland command rather than silently mapping it to a host command.

## GNU Make Strategy

GNU make is part of the real acceptance path. Add `packages/c-ports/make/` and
attempt to build `make.wasm` through `cpcc`.

The first make target is intentionally plain:

- static executable
- no jobserver
- no parallel build requirement
- no loadable objects
- no Guile
- no NLS/gettext dependency unless configure requires it for a clean build

The sandbox test command should start with:

```sh
cd /work/zsh && make TESTNUM=A check
```

then broaden category by category.

### Make Side-Quest Gate

The make port is allowed to expose useful platform holes, but it should not
consume the whole zsh effort without an explicit decision.

Stop and report before continuing if make requires any of these:

- a large new library port unrelated to zsh testing
- host command execution during sandbox runtime
- recursive process features beyond `spawn`, `fork`, `exec`, and `waitpid`
- broad filesystem semantics not already required by zsh tests
- more than a small, reviewable patch set

At that point the acceptable choices are:

1. Continue the make port because the exposed holes are worth fixing now.
2. Temporarily drive `runtests.zsh` directly with upstream-equivalent env.
3. Narrow the first zsh acceptance slice.

The implementation must not silently choose option 2.

## Test Harness Architecture

Add a zsh test runner script, likely:

```text
scripts/run-zsh-upstream-tests-in-sandbox.ts
```

Responsibilities:

1. Create a sandbox with a large enough VFS and process limit.
2. Register `zsh.wasm`, `make.wasm` while the make path is active, and the
   BusyBox test applets.
3. Install the BusyBox shell artifact with `/bin/sh` and run the ash smoke slice
   before the make or zsh slices.
4. Mount or copy the zsh build/test tree into the sandbox at `/work/zsh`,
   including `Src/`, `Test/`, `Functions/`, `Completion/`, `config.modules`,
   generated Makefiles, generated headers, and generated helper files required
   by the selected categories.
5. Run category slices with explicit `TESTNUM` values.
6. Capture stdout/stderr, exit status, timeout, and per-test summary lines.
7. Emit JSON summary to `packages/c-ports/zsh/build/test-results/*.json`.

The runner should support:

```sh
deno run -A scripts/run-zsh-upstream-tests-in-sandbox.ts --testnum A
deno run -A scripts/run-zsh-upstream-tests-in-sandbox.ts --testnum A,B,C
deno run -A scripts/run-zsh-upstream-tests-in-sandbox.ts --all
deno run -A scripts/run-zsh-upstream-tests-in-sandbox.ts --continue --verbose
```

When GNU make is available, the runner invokes make. If the make side-quest gate
has been explicitly resolved in favor of the direct driver, the runner invokes
`../Src/zsh +Z -f <source Test dir>/runtests.zsh` from `/work/zsh/Test` with the
upstream-equivalent env and records that mode in the result JSON.

## Kernel And Guest-Compat Expectations

This work is expected to find missing behavior. The implementation should prefer
small canaries before broad zsh debugging when a failure points to platform
semantics.

Likely areas:

- `execve()` must preserve the child process model expected after `fork()`.
  The current spawn-and-wait emulation does not preserve PID continuity and is
  expected to fail full zsh cases that depend on real child image replacement.
- `posix_spawn_file_actions_*` currently only preserves stdio-shaped actions.
  zsh or make may require non-stdio fd inheritance.
- `fcntl`, `ioctl`, `isatty`, `termios`, and process-group/job-control calls
  must fail honestly or implement enough behavior for zsh to disable features.
- `signal`, `trap`, and child status encoding need enough fidelity for shell
  tests.
- Directory fd snapshots, cwd handling, and unlink/rename semantics will be
  stressed by the test harness.

Every platform fix must get a focused canary or unit test before relying on the
zsh suite as evidence.

## Test Slices

Run in this order:

1. **BusyBox source trace:** record ash's `fork`/`vfork`/`exec*`/`waitpid`
   usage for the pinned source.
2. **Ash build smoke:** `sh -c 'echo ok'`
3. **Ash pipeline smoke:** `sh -c 'echo hi | cat'`
4. **Ash subshell smoke:** `sh -c '(echo child); echo parent'`
5. **Ash command substitution smoke:** `sh -c 'x=$(echo sub); echo "$x"'`
6. **Ash exec/status smoke:** `sh -c 'true; false; echo $?'`
7. **Ash shebang smoke:** executable script with `#!/bin/sh`
8. **Zsh build smoke:** `zsh -fc 'print ok'`
9. **Zsh process smoke:** `zsh -fc 'print parent=$$; (print child=$$); print done'`
10. **Zsh pipeline smoke:** `zsh -fc 'print hello | cat'`
11. **Zsh exec smoke:** `zsh -fc 'command true; command false; print $?'`
12. **Harness smoke:** one simple `.ztst` file through `runtests.zsh`
13. **Category A:** basic command parsing and execution
14. **Category B:** builtins
15. **Category C:** special shell command syntax
16. **Category D:** substitution
17. **Category E/K/Z:** options, ksh features, separate systems/contrib
18. **Categories V/W/X/Y:** modules, interactive constructs, ZLE, completion
19. **Full suite:** upstream `make check`

Categories that are genuinely interactive, tty-only, or dynamic-module-only may
be marked blocked, but only with a concrete reason and only after the
non-interactive core has passed.

## Reporting

The final report should include:

- zsh upstream commit/tag
- BusyBox upstream version and enabled applets
- BusyBox ash process-path trace result for the pinned source
- GNU make upstream version or explicit side-quest decision
- command used for each test slice
- pass/fail/skip/block counts
- first failing test in each category
- platform fixes made to support the suite
- remaining unsupported upstream tests, with rationale

## File Map

Expected new or modified files:

```text
packages/c-ports/zsh/
  .gitignore
  Makefile
  README.md
  manifest.json
  patches/*.patch
  upstream/                     # git submodule

packages/c-ports/make/
  .gitignore
  Makefile
  README.md
  manifest.json
  patches/*.patch
  upstream/                     # git submodule or pinned source

packages/c-ports/busybox/
  busybox.config
  busybox-shell.config or busybox-tests.config
  manifest.json
  busybox-shell.manifest.json or busybox-tests.manifest.json

scripts/run-zsh-upstream-tests-in-sandbox.ts
scripts/run-busybox-ash-smoke-in-sandbox.ts or ash mode in the zsh runner

packages/kernel/src/__tests__/
  zsh-upstream.test.ts or focused process/userland regression tests

packages/guest-compat/
  focused syscall/process canaries as failures require
```

## Open Risks

1. **Real `execve()` may be required earlier than expected.** If zsh uses
   fork/exec in ways where PID continuity matters, the current emulation must be
   replaced before broad tests pass.
2. **Terminal behavior may block interactive categories.** The non-interactive
  core remains valuable even if ZLE/completion categories need a separate tty
  model.
3. **Ash may expose process holes before zsh.** That is useful and intended;
   stop on ash failures long enough to add focused platform canaries instead of
   burying the same issue in the larger zsh harness.
4. **Make may expose more process holes than zsh itself.** That is useful if the
   holes are core platform behavior; otherwise use the side-quest gate.
5. **Asyncify overhead may be high.** zsh is large and continuation-enabled.
   The test runner should use generous but finite timeouts and report timeouts
   distinctly from semantic failures.
6. **BusyBox breadth can mask missing standalone tools.** The test harness must
   record the applet manifest so failures are reproducible.

## Approval Criteria For Implementation Plan

Before implementation begins, the plan must:

1. Start with source pins and build scaffolding.
2. Add BusyBox ash as `/bin/sh` and pass ash smokes before GNU make or zsh.
3. Add BusyBox test applets before running zsh tests.
4. Attempt GNU make before adding a direct zsh harness fallback.
5. Add small canaries for any platform behavior needed by ash or zsh failures.
6. Keep commits slice-sized: source pins, BusyBox ash, BusyBox applet expansion,
   make port, zsh port, runner, then platform fixes.
