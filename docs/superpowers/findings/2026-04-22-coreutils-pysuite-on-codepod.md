# Coreutils test_coreutils.py on Codepod — 2026-04-24

**Runner**: `scripts/run-coreutils-pysuite-in-sandbox.ts`
**Strategy**: Fresh Deno subprocess per section (25 sections × 1 sandbox each)
**Total elapsed**: 102.6s
**Test script**: `packages/coreutils/tests/test_coreutils.py` (unmodified)
**Sandbox fixtures**: `packages/orchestrator/src/platform/__tests__/fixtures/`

## Performance Context

Running `test_coreutils.py` via RustPython-in-WASM is memory-intensive: each `subprocess.run()`
call spawns a new WASM process and the V8 heap is not reclaimed between calls within the same
Deno process. The runner uses a **separate Deno subprocess per section** (via `Deno.Command`
with `AbortController` timeout) to isolate heap usage. This gives true OS-level kill on timeout
and complete WASM memory reclamation between sections.

The per-section helper is `scripts/run-coreutils-section.ts`. The test_coreutils.py module is
loaded via `importlib` so its `if __name__ == "__main__"` block does not run; only the
specified `register_*_tests()` function is called.

## Summary

| Category | Count |
|---|---|
| PASS | 144 |
| FAIL | 20 |
| SKIP | 0 |
| **Total** | **164** |

### Failure breakdown

| Classification | Count |
|---|---|
| `needs-fork` | 0 |
| `runtime-gap` | 20 |
| `test-env` | 0 |
| `unknown` | 0 |

**Exit policy**: 1 section(s) timed out (register_seq_extra_tests). Results are partial. Exiting 0 (partial results treated as baseline). BLOCKED: needs investigation.

## Per-Section Results

| Section | PASS | FAIL | SKIP | Time |
|---|---|---|---|---|
| `register_echo_tests` | 17 | 0 | 0 | 0.6s |
| `register_basename_tests` | 8 | 4 | 0 | 0.5s |
| `register_seq_tests` | 8 | 2 | 0 | 0.5s |
| `register_wc_tests` | 10 | 0 | 0 | 0.5s |
| `register_cut_tests` | 8 | 2 | 0 | 0.5s |
| `register_head_tests` | 5 | 3 | 0 | 0.5s |
| `register_tail_tests` | 7 | 1 | 0 | 0.5s |
| `register_sort_tests` | 9 | 1 | 0 | 0.5s |
| `register_uniq_tests` | 9 | 0 | 0 | 0.5s |
| `register_base64_tests` | 7 | 1 | 0 | 0.5s |
| `register_fold_tests` | 5 | 0 | 0 | 0.6s |
| `register_paste_tests` | 6 | 0 | 0 | 0.7s |
| `register_tr_tests` | 10 | 0 | 0 | 0.5s |
| `register_dirname_tests` | 7 | 0 | 0 | 0.5s |
| `register_basename_edge_tests` | 5 | 0 | 0 | 0.5s |
| `register_seq_extra_tests` | 0 | 0 | 0 | 90.1s (TIMEOUT) |
| `register_sort_extra_tests` | 3 | 1 | 0 | 0.5s |
| `register_head_tail_extra_tests` | 1 | 2 | 0 | 0.5s |
| `register_wc_extra_tests` | 3 | 0 | 0 | 0.5s |
| `register_cut_extra_tests` | 3 | 0 | 0 | 0.5s |
| `register_tr_extra_tests` | 3 | 0 | 0 | 0.5s |
| `register_base64_extra_tests` | 3 | 1 | 0 | 0.5s |
| `register_uniq_extra_tests` | 2 | 1 | 0 | 0.5s |
| `register_fold_extra_tests` | 3 | 0 | 0 | 0.5s |
| `register_paste_extra_tests` | 2 | 1 | 0 | 0.5s |

## Classification Key

- **`needs-fork`**: Genuine §Non-Goals per spec lines 76–88 (`fork()`/`execve()`/job control). Legit skip.
- **`runtime-gap`**: Codepod should support this, currently doesn't. Tracked follow-up.
- **`test-env`**: Test expects specific env (TTY, root, /proc, network) not in sandbox. Usually harness-setup fix.
- **`unknown`**: Needs investigation.

## Tolerance Justification

First run: tolerance set to 999 (capture all). Reviewer should set a real threshold after reviewing.

## Per-Failure Details


### FAIL: basename_multiple

- **Tool**: `basename`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got '-a\n'

---

### FAIL: basename_suffix_param

- **Tool**: `basename`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got '-s\n'

---

### FAIL: basename_zero_terminated

- **Tool**: `basename`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got '-z\n'

---

### FAIL: basename_too_many_args

- **Tool**: `basename`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: expected nonzero exit code

---

### FAIL: seq_separator_empty

- **Tool**: `seq`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got '2/home/user/3/home/user/4/home/user/5/home/user/6\n'

---

### FAIL: seq_decimal

- **Tool**: `seq`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: expected 4 lines, got 1: ['']

---

### FAIL: cut_bytes

- **Tool**: `cut`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: cut_complement

- **Tool**: `cut`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: head_c5

- **Tool**: `head`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: head_n_negative

- **Tool**: `head`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: head_byte_syntax

- **Tool**: `head`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: tail_no_trailing_newline

- **Tool**: `tail`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got 'b\n'

---

### FAIL: sort_stable

- **Tool**: `sort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: base64_wrap_zero

- **Tool**: `base64`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got 'aGVsbG8sIHdvcmxk\n'

---

### FAIL: sort_check_sorted

- **Tool**: `sort`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: expected 0, got 2

---

### FAIL: head_c_negative

- **Tool**: `head`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: tail_c_from_beginning

- **Tool**: `tail`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got 'def'

---

### FAIL: base64_file

- **Tool**: `base64`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: uniq_all_repeated

- **Tool**: `uniq`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ''

---

### FAIL: paste_unequal_files

- **Tool**: `paste`
- **Classification**: `runtime-gap`
- **Reason**: Output mismatch — possible coreutils WASM behavior gap vs expected output
- **Message**: got ['1\ta', '2\tb', '3']


## Timed-Out Sections

- `register_seq_extra_tests`
