# BusyBox Upstream Testsuite on Codepod — 2026-04-25

**Runner**: `scripts/run-busybox-testsuite-in-sandbox.ts`
**Elapsed**: 2.7s
**BusyBox binary**: `packages/c-ports/busybox/build/busybox.wasm`
**Sandbox fixtures**: `packages/orchestrator/src/platform/__tests__/fixtures/`

## Important Context: Minimal BusyBox Build

The BusyBox binary in the codepod fixtures is built with a **minimal .config** (only `grep`, `head`, `seq` enabled) as a canary for the guest-compat runtime. The full upstream testsuite has 66+ applet test files; only tests for those 3 applets produce meaningful results. All other applet tests self-SKIP via the CONFIG_ flag checks in the test harness.

**Follow-up tracked**: Full BusyBox build with all applets enabled is needed for comprehensive upstream testsuite validation. See docs/superpowers/plans/ for Phase B scope.

## Infrastructure Gap: runtest "implemented" Detection

The upstream `runtest` script uses a shell pipeline pattern that doesn't work in the sandbox:
1. **Absolute-path subprocess spawning**: `/tmp/testsuite/busybox` (a VFS symlink to `/usr/bin/busybox`) fails when the sandbox process manager tries to resolve it — the host error "No such file or directory" occurs because VFS symlinks don't resolve to host filesystem paths.
2. **xargs-within-while-read pipeline**: `xargs` inside a `while read` loop piped from a subprocess doesn't receive stdin from the pipe correctly.

**Workaround**: This runner bypasses `runtest` and invokes each `.tests` file directly with the proper env. Uses a shell wrapper at `/tmp/testsuite/busybox` (not a symlink) to work around issue 1.

**Classification**: `runtime-gap` — tracked follow-up for shell subprocess stdin routing and VFS symlink resolution in absolute-path spawn context.

## Infrastructure Gap: bc/interactive stdin hang

Tests that run interactive programs (e.g., `bc.tests`) hang indefinitely because the program waits for stdin to close, but the sandbox shell doesn't send EOF after the pipe input. This is a sandbox shell pipe EOF delivery gap.

Each `.tests` file is run in a fresh sandbox with a 30s timeout to protect against this.

**Classification**: `runtime-gap` — shell pipe EOF not delivered to subprocess stdin when shell command completes.

## Summary

| Category | Count |
|---|---|
| PASS | 153 |
| FAIL | 0 |
| SKIP | 68 |
| UNTESTED | 46 |
| **Total** | **267** |
| Timed out / crashed | 0 |

### Failure breakdown

| Classification | Count |
|---|---|
| `needs-fork` | 0 |
| `runtime-gap` | 0 |
| `test-env` | 0 |
| `unknown` | 0 |

**Exit policy**: all upstream tests green. Exiting 0.

## Classification Key

- **`needs-fork`**: Genuine §Non-Goals per spec lines 76–88 (`fork()`/`execve()`/job control). Legit skip.
- **`runtime-gap`**: Codepod should support this, currently doesn't. Tracked follow-up needed.
- **`test-env`**: Test expects specific env (TTY, root, /proc, network) not provided by sandbox. Usually harness-setup fix.
- **`unknown`**: Insufficient info; needs investigation.

## Per-Failure Details

_No failures!_

## Test Result Summary

```
UNTESTED: all_sourcecode.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: ar.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: ash.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: bunzip2.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: bzcat.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: cal.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: cpio.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: cryptpw.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: gunzip.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: hexdump.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: makedevs.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: mdev.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: mkfs.minix.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: mount.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: parse.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: pidof.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: rx.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: sha3sum.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: start-stop-daemon.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: taskset.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: test.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: time.tests (applet not available — neither in BusyBox config nor standalone fixture)
PASS: tsort empty2
PASS: tsort singleton
PASS: tsort simple
PASS: tsort 2singleton
PASS: tsort medium
PASS: tsort std.example
PASS: tsort prefixes
PASS: tsort odd
PASS: tsort odd2
PASS: tsort cycle
UNTESTED: uncompress.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: unlzma.tests (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: uuencode.tests (applet not available — neither in BusyBox config nor standalone fixture)
PASS: basename-does-not-remove-identical-extension
PASS: basename-works
UNTESTED: bunzip2/bunzip2-removes-compressed-file (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: bunzip2/bunzip2-reads-from-standard-input (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: bzcat/bzcat-does-not-remove-compressed-file (applet not available — neither in BusyBox config nor standalone fixture)
PASS: cat-prints-a-file
PASS: cat-prints-a-file-and-standard-input
PASS: cmp-detects-difference
PASS: cp-copies-small-file
PASS: cp-a-files-to-dir
PASS: cp-follows-links
PASS: cp-preserves-source-file
PASS: cp-copies-large-file
PASS: cp-copies-empty-file
PASS: cp-dev-file
PASS: cp-does-not-copy-unreadable-file
PASS: cp-RHL-does_not_preserve-links
PASS: cp-dir-create-dir
PASS: cp-preserves-hard-links
PASS: cp-preserves-links
PASS: cp-parents
PASS: cp-files-to-dir
PASS: cp-a-preserves-links
PASS: cp-dir-existing-dir
PASS: cp-d-files-to-dir
PASS: cut-cuts-an-open-range
PASS: cut-cuts-an-unclosed-range
PASS: cut-cuts-a-closed-range
PASS: cut-cuts-a-field
PASS: cut-cuts-a-character
UNTESTED: date/date-u-works (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: date/date-timezone (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: date/date-R-works (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: date/date-works-1 (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: date/date-format-works (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: date/date-works (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: date/date-@-works (applet not available — neither in BusyBox config nor standalone fixture)
PASS: dd-accepts-of
PASS: dd-copies-from-standard-input-to-standard-output
PASS: dd-count-bytes
PASS: dd-reports-write-errors
PASS: dd-prints-count-to-standard-error
PASS: dd-accepts-if
PASS: dirname-handles-relative-path
PASS: dirname-handles-empty-path
PASS: dirname-handles-absolute-path
PASS: dirname-handles-root
PASS: dirname-works
PASS: dirname-handles-multiple-slashes
PASS: dirname-handles-single-component
PASS: du-s-works
PASS: du-h-works
PASS: du-works
PASS: du-l-works
PASS: du-k-works
PASS: du-m-works
PASS: echo-prints-arguments
PASS: echo-does-not-print-newline
PASS: echo-prints-slash_0041
PASS: echo-prints-slash-zero
PASS: echo-prints-slash_00041
PASS: echo-prints-slash_041
PASS: echo-prints-non-opts
PASS: echo-prints-newline
PASS: echo-prints-dash
PASS: echo-prints-slash_41
PASS: echo-prints-argument
PASS: expr-big
PASS: expr-works
UNTESTED: false/false-is-silent (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: false/false-returns-failure (applet not available — neither in BusyBox config nor standalone fixture)
PASS: find-supports-minus-xdev
UNTESTED: gunzip/gunzip-reads-from-standard-input (applet not available — neither in BusyBox config nor standalone fixture)
PASS: gzip-accepts-multiple-files
PASS: gzip-compression-levels
PASS: gzip-removes-original-file
PASS: gzip-accepts-single-minus
PASS: hostid-works
PASS: hostname-d-works
PASS: hostname-works
PASS: hostname-i-works
PASS: hostname-s-works
PASS: id-u-works
PASS: id-g-works
PASS: id-ur-works
PASS: id-un-works
PASS: ln-force-creates-hard-links
PASS: ln-preserves-soft-links
PASS: ln-creates-hard-links
PASS: ln-preserves-hard-links
PASS: ln-creates-soft-links
PASS: ln-force-creates-soft-links
PASS: ls-s-works
PASS: ls-h-works
PASS: ls-1-works
PASS: ls-l-works
PASS: md5sum-verifies-non-binary-file
PASS: mkdir-makes-a-directory
PASS: mkdir-makes-parent-directories
PASS: mv-moves-empty-file
PASS: mv-moves-large-file
PASS: mv-moves-small-file
PASS: mv-moves-file
PASS: mv-preserves-links
PASS: mv-refuses-mv-dir-to-subdir
PASS: mv-moves-symlinks
PASS: mv-files-to-dir-2
PASS: mv-removes-source-file
PASS: mv-preserves-hard-links
PASS: mv-follows-links
PASS: mv-moves-hardlinks
PASS: mv-files-to-dir
PASS: mv-moves-unreadable-files
PASS: paste-pairs
PASS: paste-separate
PASS: paste-multi-stdin
PASS: paste-back-cuted-lines
PASS: paste
UNTESTED: pwd/pwd-prints-working-directory (applet not available — neither in BusyBox config nor standalone fixture)
PASS: rm-removes-file
PASS: rmdir-removes-parent-directories
PASS: strings-works-like-GNU
PASS: tail-works
PASS: tail-n-works
PASS: tar_with_prefix_fields
PASS: tar-handles-multiple-X-options
PASS: tar-handles-empty-include-and-non-empty-exclude-list
PASS: tar-demands-at-most-one-ctx
PASS: tar-handles-cz-options
PASS: tar-extracts-from-standard-input
PASS: tar-extracts-all-subdirs
PASS: tar-handles-exclude-and-extract-lists
PASS: tar-demands-at-least-one-ctx
PASS: tar-extracts-multiple-files
PASS: tar-archives-multiple-files
PASS: tar-handles-nested-exclude
PASS: tar_with_link_with_size
PASS: tar-extracts-to-standard-output
PASS: tar-extracts-file
PASS: tar-complains-about-missing-file
PASS: tee-appends-input
PASS: tee-tees-input
PASS: touch-creates-file
PASS: touch-touches-files-after-non-existent-file
PASS: touch-does-not-create-file
PASS: tr-d-works
PASS: tr-non-gnu
PASS: tr-d-alnum-works
PASS: tr-works
PASS: tr-rejects-wrong-class
UNTESTED: true/true-is-silent (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: true/true-returns-success (applet not available — neither in BusyBox config nor standalone fixture)
PASS: uptime-works
PASS: wc-counts-all
PASS: wc-prints-longest-line-length
PASS: wc-counts-words
PASS: wc-counts-lines
PASS: wc-counts-characters
UNTESTED: wget/wget-supports--P (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: wget/wget-handles-empty-path (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: wget/wget--O-overrides--P (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: wget/wget-retrieves-google-index (applet not available — neither in BusyBox config nor standalone fixture)
UNTESTED: which/which-uses-default-path (applet not available — neither in BusyBox config nor standalone fixture)
PASS: xargs-works
```
