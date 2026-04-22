# Guest Compatibility Runtime — Acceptance Ledger

> **Status:** Complete as of `1afdae4b4f5c715ab27974053564b8c79c97af0f`.
>
> Normative spec: [`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../specs/2026-04-19-guest-compat-runtime-design.md)
>
> This document maps each §Acceptance Criteria bullet (spec lines 853–878)
> to the concrete artifact that proves it is satisfied. Evidence is either
> a file in the repo, a git commit, or a CI step name in
> `.github/workflows/guest-compat.yml`.

| # | Acceptance criterion (abridged) | Proof point |
|---|---------------------------------|-------------|
| 1 | Written platform spec for a shared guest compatibility ABI. | This repo at `docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`. |
| 2 | `packages/c-compat/` renamed to `packages/guest-compat/` and hosts both C and Rust frontends. | Directory layout: `packages/guest-compat/{src,include,toolchain/cpcc,rust/codepod-guest-compat-sys,rust/codepod-guest-compat,conformance/c,conformance/rust}`. Renamed in Step 1. |
| 3 | Shared runtime ships as `libcodepod_guest_compat.a`, linked `--whole-archive` by both frontends. | Build target: `packages/guest-compat/Makefile` target `lib`. C side: `packages/guest-compat/toolchain/cpcc/src/main.rs`. Rust side: `packages/guest-compat/toolchain/cpcc/src/cargo_codepod.rs:85-104` (RUSTFLAGS injection). |
| 4 | Two driver wrappers (`codepod-cc`, `cargo-codepod`) released together from `packages/guest-compat/toolchain/`. | Binaries produced by `cargo build --release -p cpcc-toolchain`: `cpcc`, `cpar`, `cpranlib`, `cpcheck`, `cpconf`, `cargo-codepod`. Source: `packages/guest-compat/toolchain/cpcc/src/bin/`. |
| 5 | Tier 1 symbol set identical in both frontends; paired C and Rust canaries pass a shared behavioral spec. | Canonical list: `packages/guest-compat/toolchain/cpcc/src/lib.rs` const `TIER1` (16 symbols). Behavioral specs: `packages/guest-compat/conformance/*.spec.toml` (16 files). C canaries: `packages/guest-compat/conformance/c/*-canary.c`. Rust canaries: `packages/guest-compat/conformance/rust/*-canary/`. CI step `Run conformance driver (C + Rust)` in `.github/workflows/guest-compat.yml`. |
| 6 | Implementation-signature check confirms the compat implementation is linked for every Tier 1 symbol in every canary and real-consumer `.wasm`. | Canaries: `cpconf --include-rust` runs `cpcheck` over both C and Rust pre-opt wasms (`packages/guest-compat/toolchain/cpcc/src/conform.rs`). Real consumers: three CI steps in `.github/workflows/guest-compat.yml` — `Signature-check BusyBox`, `Signature-check every coreutils binary`, and the `cpcheck` invocation inside `packages/rust-ports/grex.build.sh`. |
| 7 | Named real consumers — BusyBox (`codepod-cc`), `packages/coreutils/` (`cargo-codepod`), one unmodified third-party Rust CLI (`cargo-codepod`) — pass their own suites. | BusyBox: `make -C packages/c-ports/busybox all` in CI step `Build BusyBox via cpcc`; orchestrator E2E via `packages/orchestrator/src/__tests__/guest-compat.test.ts`. coreutils: `./scripts/build-coreutils.sh --engine=cargo-codepod` (default) + full orchestrator suite under the `test` job (CLAUDE.md §Key Commands). Third-party: `grex` v1.4.6 at `packages/rust-ports/grex/` (submodule pinned at `db9275ace11ad455700656c6186e0d69f6107870`) built by `packages/rust-ports/grex.build.sh` + CI smoke step `Smoke-run grex via wasmtime`. |
| 8 | Repo structure and docs make clear that compatibility is a platform feature, not a C-only subsystem. | Directory naming (`guest-compat`, not `c-compat`). `packages/rust-ports/README.md` explains the Rust port pattern. Spec §Outcome, §Goals, §Repository Shape (lines 14–33, 56–75, 726–755). |

## Commit list (chronological, this branch)

The following commits, on branch `feature/guest-compat-step-1`, land the
complete feature:

- **Steps 1–2** (rename, toolchain, docs): branch history prior to the Step 3 plan's merge base.
- **Step 3** (Rust frontend, conformance harness, CI): see
  `docs/superpowers/plans/2026-04-22-guest-compat-runtime-step-3.md`. 19 tasks, 22 commits.
- **Step 4+5** (this plan):
  - Task 1: `feat(guest-compat/step-4): add busybox signature-check gate (Task 1)` — `9259c3a`
  - Task 2: `feat(guest-compat/step-4): add --engine=cargo-codepod backend to build-coreutils.sh (Task 2)` — `415d035`
  - Task 3: `feat(guest-compat/step-4): switch coreutils build default to cargo-codepod (Task 3)` — `4543c8a`
  - Task 3 follow-up: `fix(guest-compat/step-4): keep codepod-shell-exec on plain cargo (Task 3 follow-up)` — `173c56b` (restores shell-exec after cargo-codepod inadvertently reshaped it)
  - Task 4: no commit — regression baseline verified
  - Task 5: `feat(guest-compat/step-5): add coreutils signature-check harness (Task 5)` — `9840a95`
  - Task 6: `feat(guest-compat/step-5): vendor tokei@v12.1.2 as rust-ports submodule (Task 6)` — `7f193a9` (later swapped to grex)
  - Task 7 initial: `feat(guest-compat/step-5): add tokei build recipe + signature gate (Task 7)` — `a7aedd0` (incompatible, superseded)
  - Task 7 toolchain enhancement: `feat(guest-compat): CPCC_NO_CLANG_LINKER env to skip wasi-sdk clang` — `724437c`
  - Task 7 consolidation: `fix(guest-compat/step-5): swap tokei→grex + CPCC_NO_CLANG_LINKER (Task 7)` — `5f9f9ff`
  - Task 8: `ci(guest-compat/step-5): gate BusyBox, coreutils, and grex on §Verifying Precedence (Task 8)` — `1afdae4`
  - Task 9: `docs(guest-compat/step-5): acceptance ledger + mark spec complete (Task 9)` — HEAD

## Prior attempts

- `tokei@v12.1.2` was the initial candidate for the third-party Rust CLI
  (Task 6 landed at `7f193a9`; initial build recipe at `a7aedd0`).
  Tokei's transitive dep `memmap v0.7.0` has no wasm32-wasip1
  implementation, so it can't compile to the target. Swapped to grex in
  the Task 7 consolidation commit `5f9f9ff`.

## Known non-regressions (not this feature's scope)

- Pre-existing test failures in the orchestrator suite (primarily in
  `packages/orchestrator/src/__tests__/native-bridge.test.ts` and
  `packages-integration.test.ts`, plus a small number of other files) predate
  this branch. Verified unchanged in Step 4 Task 4's regression run.
- coreutils fixture size after the cargo-codepod flip was actually
  **smaller** than the pre-flip baseline (-3.3 MB aggregate) because
  `cargo-codepod`'s wasm-opt pass more than offsets the per-binary
  compat-archive link cost. The spec's `--whole-archive` precedence
  guarantee is preserved.

## Out of scope (Phase B)

Per spec §Rust Integration Strategy > Phase B: custom
`wasm32-wasip1-codepod` target, deeper libc crate integration, custom
Rust toolchain distribution. Deferred; not required by §Acceptance Criteria.
