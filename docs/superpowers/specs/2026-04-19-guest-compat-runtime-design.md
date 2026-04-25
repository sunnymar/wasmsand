# codepod Guest Compatibility Runtime

## Status

Complete as of commit `2cb3d9c`. Implementation landed across Steps 1–5
per §Migration Path. Acceptance proof points — including real-consumer
testsuite runs with their honest pass/fail/skip numbers and tracked
follow-ups — at
[`docs/superpowers/acceptance/2026-04-22-guest-compat-runtime-acceptance.md`](../acceptance/2026-04-22-guest-compat-runtime-acceptance.md).

C and Rust are first-class frontends over the same runtime; neither is primary.

This document extends the existing C ABI compatibility work into a
language-neutral platform feature. The goal is not "better C support" in
isolation. The goal is a single guest compatibility ABI that simple C programs
and simple Rust crates can both rely on when targeting `wasm32-wasip1` on
codepod, with identical semantics and equal ergonomics.

## Outcome

The target end state is:

- simple C programs build with minimal changes
- simple Rust crates and utilities build with minimal changes
- both languages resolve onto the same guest compatibility ABI and exhibit
  identical observable semantics for every blessed symbol
- the C and Rust toolchains are two frontends over one shared compat runtime,
  developed and supported in lockstep
- once that ABI is validated by real ports, codepod can choose to move from
  link-time compatibility shims toward deeper Rust/WASI libc or stdlib
  integration

The product requirement is shared *semantics*, not identical linked object
code. Phase A ships a single shared archive as the default mechanism because
that is the simplest way to guarantee equivalence, but the normative contract
is the ABI and its behavioral spec — not the build artifact. Future phases
may diverge the implementation (e.g. a Rust-native reimplementation of a
subset) as long as the conformance suite stays green.

## Problem

The current implementation has shown that codepod can support a useful subset
of Unix-like functionality beyond plain WASI:

- `dup2()` over guest-visible file descriptors
- single-visible-CPU affinity
- narrow `signal` / `sigaction` / `raise` behavior
- `getgroups()` as a portability shim
- subprocess-style helpers on top of `host_run_command`

The implementation lives in `packages/c-compat`, its headers and build flow
assume `wasi-sdk`, and Rust can only benefit indirectly. If codepod continues
on that path it will accumulate two parallel compatibility stories — one for
C, one for Rust — plus ad hoc exceptions in ports and builders. That is the
wrong architecture. Compatibility must be a platform feature first, and a
language integration second. The two language integrations must share one
normative ABI and behavioral spec; sharing the compiled artifact is the
default mechanism in Phase A but is not itself the contract (see §Outcome).

## Goals

- Define a single guest compatibility ABI shared by C and Rust as equal
  frontends.
- Keep `wasm32-wasip1` and standard WASI behavior as the base ABI; override
  only where codepod intentionally supplies stronger or different semantics.
- Provide transparent-by-default compatibility for a narrow, explicit subset
  of APIs in both C and Rust, without requiring callers to use
  codepod-specific APIs.
- In Phase A, make the C builder and the Rust builder link the same shared
  compat archive with identical link-order and precedence rules. This is the
  default mechanism; the normative requirement is semantic equivalence
  demonstrated by conformance, not archive identity.
- Validate each blessed compat symbol with:
  - a C canary
  - a Rust canary
  - a shared behavioral spec both canaries execute against
  - at least one real package or tool in each language
- Preserve a staged path toward deeper Rust/WASI libc or std integration once
  the ABI is proven.

## Non-Goals

- Full POSIX compatibility.
- Immediate replacement of `wasi-libc`, musl, glibc, or Rust `std`.
- Shared libraries or `.so` support.
- `fork()` / `execve()` / Unix job control.
- A promise that arbitrary Unix C or Rust software will build unchanged.

Deeper toolchain integration (custom Rust target, custom sysroot, libc/std
forks) is *not* a non-goal — it is deferred to Phase B, below, after the
shared ABI is validated. The non-goal is doing that work *before* the ABI is
proven.

## Design Approaches

### 1. C-Only Compatibility Layer

Keep compatibility work in a C-only library and add Rust wrappers separately.

Advantages:

- fastest short-term iteration for BusyBox and other C ports

Disadvantages:

- guarantees semantic drift between C and Rust
- duplicates runtime policy in two places
- fails the product goal of transparent first-class Rust support

This approach is rejected.

### 2. Shared Guest Compatibility ABI With Symmetric Language Frontends

Define one guest compatibility runtime, compiled once into a single static
archive, and make both the C and Rust builders link it with the same link
order, the same override precedence, and the same validation.

Advantages:

- one runtime contract
- one semantic source of truth
- one compiled artifact by default (cheapest way to guarantee equivalence)
- transparent behavior in both languages by default
- incremental path toward deeper libc integration later

Disadvantages:

- requires careful build and link design, up front, for both languages
- Rust integration is not a wrapper layer added later — it has to be real from
  day one, which is more work than shipping C first

This approach is selected. The cost is accepted deliberately: the
"Rust-integration-later" shape is what produces the divergence this spec
exists to prevent.

### 3. Immediate Custom Rust/WASI libc or std Fork

Skip the shared compat-runtime phase and jump directly to a customized Rust
target or libc/std integration.

Advantages:

- strongest long-term transparency if successful

Disadvantages:

- too much infrastructure risk too early
- hard to validate semantics incrementally
- mistakes turn into toolchain debt immediately

This approach is deferred until the shared ABI is proven (see Phase B).

## Architecture

The platform grows a language-neutral guest compatibility runtime. `packages/
c-compat` is renamed to `packages/guest-compat` as part of this work. The
rename is repo hygiene, not architecture — everything below works under
either name — but it is scheduled for Step 1 because headers, crate names,
and build-script paths are harder to change once real consumers depend on
them. "Pain now over pain later."

The runtime stack becomes:

1. Base ABI
   - `wasm32-wasip1`
   - `wasi_snapshot_preview1`
   - standard `wasi-libc` and Rust WASI target behavior where sufficient

2. Shared guest compatibility runtime
   - the single normative source of truth for compatibility features, defined
     by the ABI enumeration (§Compatibility Tiers) and the behavioral spec
     (§Conformance Testing)
   - in Phase A, supplied as one compiled artifact — `libcodepod_guest_compat
     .a` — linked by both frontends
   - built on top of WASI imports and the `codepod` import namespace
   - an implementation may later diverge (for example, a Rust-native version
     of a subset) as long as conformance stays green

3. Language frontends, delivered as driver wrappers (see §Toolchain
   Integration)
   - `codepod-cc` — clang wrapper (modeled on `wasixcc`): sysroot, compat
     headers, compat archive `--whole-archive` linking, optional wasm-opt
   - `cargo-codepod` — cargo subcommand (modeled on `cargo-wasix`):
     target selection, RUSTFLAGS link-arg injection, version check,
     optional wasm-opt. Works on unmodified upstream Cargo crates.
   - optional `codepod-guest-compat-sys` / `codepod-guest-compat` crates
     for codepod-authored Rust guests that want plain `cargo build` to
     also work

Language integrations must not invent their own runtime semantics. They only
surface the shared compat runtime.

## Override And Link Precedence

This section is normative for both frontends.

### Symbol Policy

- The shared runtime exports **strong** definitions for every symbol it owns
  (e.g. `dup2`, `signal`, `sigaction`, `raise`, `alarm`, `sigemptyset`,
  `sigprocmask`, `getgroups`, `sched_getaffinity`, `sched_setaffinity`,
  `sched_getcpu`, and the other symbols enumerated in Tier 1).
- `wasi-libc` provides weak or stub definitions for most of these. Link-time
  resolution must select the shared-runtime definition.
- A shared-runtime implementation **may delegate** to the corresponding
  `wasi-libc` or WASI syscall when that yields the correct semantics (for
  example, `dup2` may internally call `__wasi_fd_renumber`). Delegation is an
  implementation choice, not a contract: callers see only the shared-runtime
  semantics described in §Runtime Semantics.
- Symbols the shared runtime does *not* own pass through to `wasi-libc`
  unchanged.

### Link Order (C frontend)

The C builder must link the shared archive with `--whole-archive` so that
overriding symbols are always pulled in, and before `wasi-libc` on the link
line:

```
clang --target=wasm32-wasip1 \
  -Wl,--whole-archive <path>/libcodepod_guest_compat.a -Wl,--no-whole-archive \
  <user objects> \
  -lc
```

`--whole-archive` is required: without it, the linker will drop compat
objects whose only role is to override a weak libc symbol that nothing in the
user program explicitly references.

### Link Order (Rust frontend)

The Rust builder must produce the same effect, *without* requiring a Cargo
dependency to be added to upstream manifests (§Rust Toolchain explains why
that mechanism is not viable). The primary mechanism is `RUSTFLAGS` / per-
target link-args injected by `cargo-codepod`:

```
RUSTFLAGS="-C link-arg=-Wl,--whole-archive \
           -C link-arg=<path>/libcodepod_guest_compat.a \
           -C link-arg=-Wl,--no-whole-archive"
```

This is applied as `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS` so it composes
with any RUSTFLAGS the user has already set. Because `cargo-codepod` wraps
the `cargo` invocation, the link args reach rustc regardless of what the
upstream `Cargo.toml` or `build.rs` does; upstream `build.rs` scripts that
emit their own `cargo:rustc-link-arg` directives compose with — not against
— the compat archive framing.

For codepod-authored crates that want to build under plain `cargo build`
(e.g. in external CI), a `codepod-guest-compat-sys` crate is available as
an *optional* alternate path. It ships the same archive and emits:

```
cargo:rustc-link-search=native=<archive dir>
cargo:rustc-link-lib=static:+whole-archive+bundle=codepod_guest_compat
```

`cargo-codepod` and `codepod-guest-compat-sys` must not both inject the
archive into the same build — applying `--whole-archive` to the same
archive twice produces duplicate strong symbol definitions and the link
fails. Coordination is one-way:

- `cargo-codepod` sets `CODEPOD_LINK_INJECTED=1` in the cargo
  environment.
- The `codepod-guest-compat-sys` `build.rs` checks for that variable and
  skips emitting `cargo:rustc-link-*` directives when it is set.

The result: depending on `-sys` is harmless under `cargo-codepod`, and
required under plain `cargo build`. The `-sys` crate is not used for
upstream-crate ports.

### Verifying Precedence

Post-link `.wasm` does not preserve archive provenance in a stable,
inspectable way — "this symbol body came from `libcodepod_guest_compat.a`"
is not a first-class property of an emitted module. Verification therefore
uses two complementary proxies, neither of which depends on archive
metadata surviving link:

**Behavioral conformance (primary).** Every Tier 1 symbol has a behavioral
spec (§Conformance Testing). C and Rust canaries run the same spec in a
codepod sandbox and must produce identical traces. This is the load-bearing
check: if both frontends behave correctly, the precedence question is moot
for users.

**Implementation-signature check (secondary).** The shared runtime defines
a distinctive marker for each Tier 1 symbol — an exported function named
`__codepod_guest_compat_marker_<sym>` that returns a known constant. The
marker lets CI confirm that the compat implementation — and not a weak
libc stub — is what ended up linked.

The check runs on the **pre-`wasm-opt`** artifact, not the final binary.
This is essential: `wasm-opt` is allowed to inline Tier 1 functions,
DCE unused exports, fold equivalent bodies, and otherwise erase the
properties this check relies on. Both wrappers (`codepod-cc` and
`cargo-codepod`) must:

- emit the linked `.wasm` to a stable path before any optional
  post-processing (matching `WASIXCC_WASM_OPT_PRESERVE_UNOPTIMIZED` from
  the wasix toolchain in spirit)
- expose that path so the conformance driver can locate it

The check itself, on the pre-opt artifact:

1. Inspect the archive (or equivalent build output) with `llvm-nm`
   pre-link: every Tier 1 symbol and its marker must be defined together
   in the same object.
2. Inspect the pre-opt `.wasm`: every Tier 1 marker function must be
   exported and reachable (proves `--whole-archive` held through link).
3. Disassemble each Tier 1 function body with `wasm-tools dump` and
   assert it calls its corresponding marker function (proves the linked
   body is the compat body, not a stub that happens to share the name).
   The marker call is a side-effecting call to an exported function, so
   it survives ordinary dead-code elimination at link time even though
   `wasm-opt` may later remove it.

For the post-opt (final) `.wasm`, only the behavioral conformance check
applies. That is the load-bearing guarantee for users.

If a future implementation legitimately diverges from the shared-archive
model (e.g. a Rust-native implementation of some symbol), the
implementation-signature check is updated to match the new mechanism, and
the marker convention may evolve. The behavioral conformance check does
not change.

A Tier 1 symbol is not considered landed until both checks are green.

## Compatibility Tiers

Tiers describe the **breadth of the platform guarantee** for a symbol. They
are orthogonal to Phases, which describe implementation depth (§Rust
Integration Strategy).

### Tier 1: Transparent Shared Guest ABI

Tier 1 is available by default to both C and Rust guests. Its purpose is to
make simple programs build unchanged or nearly unchanged. It stays small,
explicit, and defensible.

Tier 1 is the authoritative enumeration. Any normative list elsewhere in this
document (including §Runtime Semantics) refers to this set.

Tier 1 symbols:

- **File descriptor compatibility**
  - `dup2`
- **Identity compatibility**
  - `getgroups`
- **Scheduler and affinity compatibility**
  - `sched_getaffinity`
  - `sched_setaffinity`
  - `sched_getcpu`
- **Narrow signal compatibility**
  - `signal`
  - `sigaction`
  - `raise`
  - `alarm`
  - `sigemptyset`
  - `sigfillset`
  - `sigaddset`
  - `sigdelset`
  - `sigismember`
  - `sigprocmask`
  - `sigsuspend`

Tier 1 rules:

- semantics are documented once, at platform level (see §Runtime Semantics)
- both C and Rust must validate against the identical behavioral spec
- each Tier 1 symbol is a platform promise, not a recipe-local hack

### Tier 2: Shared Compatibility Extensions

Tier 2 remains shared across languages, but is not assumed by every package.
It is where real codepod capabilities live when they are not yet broad enough
to be treated as universal transparent compatibility.

Likely Tier 2 candidates:

- socket and resolver compatibility
- `popen` / `system` / related subprocess surface, built on `host_run_command`
- additional credential or process-query shims

Tier 2 symbols are linked the same way as Tier 1 (shared archive,
`--whole-archive` in both frontends) but are opt-in per consumer rather than
assumed ambient.

### Tier 3: Deep Toolchain Integration

Once Tier 1 and Tier 2 behavior has been validated by real consumers, codepod
may move some or all of it into a deeper implementation — custom Rust target,
deeper `libc` or `std` integration, or more opinionated sysroot integration.

Tier 3 is an implementation evolution, not a contract change. The contract
remains the shared guest compatibility ABI. Phase B (below) is how Tier 3
gets implemented on the Rust side; the equivalent on the C side is upstream
contributions to `wasi-libc` where appropriate.

## Runtime Semantics

The shared ABI keeps the semantics already established in the C compatibility
work and promotes them to platform rules. These semantics are binding for
both C and Rust.

### Error Reporting

- Tier 1 calls report errors via POSIX-style `errno` values exposed through
  `__errno_location`, the same mechanism `wasi-libc` uses.
- Rust callers see these values through `std::io::Error::last_os_error()` and
  the `libc` crate's `errno` helpers, without additional glue.
- Shared-runtime implementations must set `errno` on failure and return the
  POSIX-convention error indicator for their signature.

### File Descriptors

- `dup2(oldfd, newfd)` is supported for guest-visible descriptor renumbering.
- Redirection over actual WASI stdio targets is part of the contract.
- Invalid descriptors fail with `EBADF`.

### Identity

- `getgroups(0, NULL)` reports a single visible group.
- `getgroups(1, list)` stores the single visible guest group id `0`.
- This is a portability shim, not a full Unix credential model.

### Affinity

- The guest sees exactly one visible CPU: CPU `0`.
- `sched_getaffinity()` reports CPU `0`.
- `sched_setaffinity()` succeeds only for masks selecting exactly CPU `0`;
  other masks fail with `EINVAL`.
- `sched_getcpu()` returns `0`.

### Signals

- Signal support is intentionally partial.
- Handlers are process-local guest registrations.
- `raise()` dispatches synchronously.
- Default terminate behavior exists for `SIGINT`, `SIGTERM`, and `SIGALRM`.
- Signal-set helpers (`sigemptyset`, `sigfillset`, `sigaddset`, `sigdelset`,
  `sigismember`, `sigprocmask`, `sigsuspend`) are provided for source
  compatibility; `sigprocmask` and `sigsuspend` operate on the guest-local
  mask only and do not observe external signal sources.
- Full Unix asynchronous signal delivery is not part of the contract.

### Subprocesses

- Subprocess support belongs to Tier 2. It is surfaced through library-level
  compatibility (`popen`, `system`, and related helpers) built on
  `host_run_command`.
- It must not be documented as `fork()` / `exec()` semantics. codepod does
  not implement that model.

## Versioning

- The shared runtime exports a sentinel symbol `codepod_guest_compat_version`
  of type `uint32_t` with value encoded as `(major << 16) | minor`.
- Public headers (C and the Rust `codepod-guest-compat` crate) expose an
  equivalent compile-time constant.
- Breaking changes to any Tier 1 symbol's semantics bump major. Additive
  changes bump minor.
- A runtime-version mismatch between the crate/header a guest was built
  against and the archive it links is a build-time error, not a runtime
  surprise. Both `codepod-cc` and `cargo-codepod` perform this check, as
  does the optional `codepod-guest-compat-sys` build script.
- The `codepod` import namespace itself is not versioned as part of this
  spec; versioning lives in the guest-compat runtime.

## Toolchain Integration

Both frontends converge on one runtime. They are developed together, updated
together, and delivered as **driver wrappers** — not as build-graph
rewriters. The user invokes a codepod tool exactly the way they would invoke
the underlying compiler or build tool; the wrapper handles sysroot, flags,
link order, archive injection, and post-processing. This mirrors the
`wasixcc` / `cargo-wasix` model from the WASIX project: wrap the driver, do
not touch the upstream build manifest.

Neither frontend ships a Tier 1 symbol the other is missing.

### C Toolchain: `codepod-cc`

`codepod-cc` is a thin wrapper around `clang` (modeled on `wasixcc`). It is
the supported way to compile C for codepod. Users run:

```
codepod-cc hello.c -o hello.wasm
codepod-cc -c hello.c -o hello.o
codepod-ar rcs libmything.a hello.o
```

The wrapper (and companion `codepod-ar`, `codepod-ranlib` tools for build
systems that invoke them directly) is responsible for:

- selecting the `wasi-sdk` sysroot and clang binary it ships with
- adding `-isystem <guest-compat>/include` so compat headers are always
  visible
- appending `-Wl,--whole-archive libcodepod_guest_compat.a -Wl,--no-whole-archive`
  before `-lc` at link time (see §Link Order)
- version-checking the archive against the installed headers and failing
  the compile if they disagree
- emitting the linked `.wasm` to a stable pre-opt path before any optional
  `wasm-opt` post-processing, so the implementation-signature check has
  an unoptimized artifact to inspect
- optionally running `wasm-opt` after link, when requested
- exposing every knob through `CODEPOD_CC_*` environment variables for
  build systems (CMake, autoconf, meson) that do not let callers control
  the CLI directly

Recipe-level patches are reserved for package-specific porting issues
(build-system quirks, missing POSIX APIs outside Tier 1/2) — they are not
where missing platform semantics get papered over.

### Rust Toolchain: `cargo-codepod`

`cargo-codepod` is a cargo subcommand (modeled on `cargo-wasix`). It is the
supported way to build Rust for codepod. Users run:

```
cargo codepod build
cargo codepod build --release
cargo codepod test
cargo codepod run
```

in **any** cargo crate — codepod-authored, workspace member, or an unchanged
upstream checkout. Upstream `Cargo.toml` is never modified, and no Cargo
dependency is silently injected. Instead, `cargo codepod` invokes the real
cargo with all the right knobs in place:

- sets the target to `wasm32-wasip1` (Phase A) or a custom
  `wasm32-wasip1-codepod` target (Phase B)
- sets `CARGO_TARGET_WASM32_WASIP1_LINKER` to the same linker the C
  frontend uses, and to the version shipped by the codepod toolchain
  distribution
- injects `RUSTFLAGS` / `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS` containing
  the link-arg sequence that pulls `libcodepod_guest_compat.a` in with
  `--whole-archive` — this is what makes the override work without a
  Cargo dependency
- performs the same version check the C wrapper performs, failing the
  build if the archive and the toolchain distribution disagree
- emits the linked `.wasm` to a stable pre-opt path before any optional
  `wasm-opt` post-processing, so the implementation-signature check has
  an unoptimized artifact to inspect
- runs `wasm-opt` on the produced `.wasm` when requested, same as the C
  wrapper
- runs the implementation-signature check (§Verifying Precedence) on
  the pre-opt artifact before reporting success
- on first use, downloads the codepod Rust toolchain distribution (same
  pattern as `cargo wasix download-toolchain`)

Because the archive is linked purely through `RUSTFLAGS` link-args,
upstream crates work unmodified: their `build.rs` may emit additional
link directives, but the `--whole-archive` pair supplied by
`cargo-codepod` frames the compat archive independently and is unaffected.

**Optional, ergonomics-only crates.** `codepod-authored` Rust guests that
want the safe wrapper surface or a `build.rs`-level version check may
depend on:

- `codepod-guest-compat-sys` — ships the archive and emits
  `cargo:rustc-link-*` directives (a standard `-sys` crate). Under
  `cargo-codepod`, its `build.rs` detects the `CODEPOD_LINK_INJECTED=1`
  env var and skips the link directives so the archive is not pulled in
  twice (see §Link Order). Under plain `cargo build`, it does the
  injection itself, letting codepod-authored crates build correctly in
  external CI without `cargo-codepod`.
- `codepod-guest-compat` — safe wrappers over the C ABI for ergonomics.
  Tier 1 semantics still reach `libc::dup2`, `libc::signal`, etc.
  through the link-time override alone; these wrappers exist for
  Rust-native types, not correctness.

Neither crate is required for correctness of upstream-crate ports. The
wrapper model means application authors write `libc::dup2`,
`nix::sys::signal::*`, and ordinary Rust; they never write codepod-specific
`extern "C"` shims.

### Parity Rule

`codepod-cc` and `cargo-codepod` are developed and released together from
`packages/guest-compat/toolchain/`. They are not required to expose the
same control surface — clang and cargo are not isomorphic, and forcing
flag-by-flag parity would either dilute useful frontend-specific knobs
or invent no-op flags. Parity is required only where it affects the
guest binary's behavior or the platform contract:

- **Behavioral defaults.** Both wrappers default to the same sysroot,
  the same compat-archive version, the same `--whole-archive` link
  treatment, the same Tier 1 enablement, the same `wasm-opt` invocation
  policy, and the same target triple selection in a given codepod
  toolchain release.
- **Shared semantics where flags overlap.** Concepts that exist in both
  surfaces — toolchain version, sysroot override, `wasm-opt`
  enable/disable, preserve-unoptimized-binary, env-var prefix
  (`CODEPOD_CC_*` / `CODEPOD_CARGO_*`) — must mean the same thing.
- **Frontend-specific flags are allowed.** `codepod-cc` carries
  `codepod-ar` / sysroot-prefix / module-kind concerns; `cargo-codepod`
  carries target/profile/cargo-subcommand concerns. Neither needs a
  fake counterpart in the other.

CI enforces this by building the same canary program through both
wrappers (with their respective default settings) and asserting
identical conformance output. Divergence in the produced wasm's
observable behavior is the failure mode, not divergence in the flag
catalog.

## Rust Integration Strategy

Rust integration proceeds in two phases, but Phase A is not a reduced
offering — it is the full first-class integration. Phase B is a future
deepening, not a completion of work Phase A left undone.

### Phase A: Wrapper-Driven Link-Time Compatibility

Rust binaries targeting codepod are built through `cargo-codepod`, which
injects the compat-archive link args via RUSTFLAGS without touching
upstream Cargo manifests. `wasm32-wasip1` is used as the underlying target;
no custom target JSON and no `-Z build-std` are required in this phase.
This is enough to validate the ABI without forking the Rust compiler or
Rust `std`.

Phase A is complete when:

- every Tier 1 symbol is overridden in Rust guests the same way it is in C
  guests, verified by behavioral conformance and the implementation-
  signature check
- `cargo-codepod` builds both codepod-authored crates and at least one
  unmodified upstream crate successfully
- the safe-wrapper crate exists for the Tier 1 surface where Rust-native
  types add value
- at least one real Rust consumer (see §Package Validation) builds and runs
  against Tier 1 with zero `unsafe extern` code in the application

### Phase B: Deeper Rust/WASI Integration

Once the ABI is proven by conformance tests and real ports, codepod may
absorb more of the compat surface into a custom Rust-target story:

- a custom `wasm32-wasip1-codepod` target profile shipped with
  `cargo-codepod`, carrying the link args and any sysroot overrides
  intrinsically (analogous to how `cargo-wasix` ships `wasm32-wasmer-wasi`)
- deeper `libc` crate integration (upstreaming or vendoring)
- deeper `std` assumptions where justified, potentially including a
  codepod-specific Rust toolchain distribution

Phase B narrows the gap where Phase A's wrapper + RUSTFLAGS approach proves
insufficient — for example, tools that embed `cargo` invocations too
deeply for `cargo-codepod` to intercept, or optimizations that require
custom target-level settings. Phase B is deferred until Phase A is
validated. It is not blocked on C-side equivalents — the two frontends
may take Phase-B-equivalent steps independently once the Tier 1 contract
is stable.

## Conformance Testing

Shared ABI claims require shared tests. "Proven equivalent by conformance
tests" has a concrete form:

### Behavioral Spec

Each Tier 1 symbol has a behavioral spec file at
`packages/guest-compat/conformance/<symbol>.spec.toml`. The spec enumerates
cases: inputs, expected outputs, expected `errno`, expected side effects
(e.g. descriptor table state after `dup2`).

### Paired Canaries

Each spec is accompanied by:

- `packages/guest-compat/conformance/c/<symbol>-canary.c`
- `packages/guest-compat/conformance/rust/<symbol>-canary/` (a cargo crate)

Each canary reads its spec file, executes the enumerated cases in order, and
emits a deterministic JSONL trace of actual outcomes.

### Conformance Driver

`scripts/run-guest-compat-conformance.sh` builds both canaries — the C
canary via `codepod-cc` and the Rust canary via `cargo-codepod` — runs them
in sandboxes, and diffs each trace against the spec. CI fails on any
divergence between C trace, Rust trace, and spec.

### Implementation-Signature Check

The driver also runs the precedence check described in §Verifying
Precedence on the **pre-`wasm-opt`** `.wasm` produced by each wrapper
(both wrappers retain the unoptimized artifact at a known path). Every
Tier 1 symbol must carry its `__codepod_guest_compat_marker_<sym>`
marker function and call it from its body. CI fails if any Tier 1 symbol
leaks through to a `wasi-libc` stub instead. The post-opt artifact is
covered only by behavioral conformance.

### Existing Canaries

The current canaries in `packages/c-ports/` (`dup2-canary.wasm`,
`signal-canary.wasm`, `getgroups-canary.wasm`, `affinity-canary.wasm`,
`sleep-canary.wasm`, `stdio-canary.wasm`, `popen-canary.wasm`,
`system-canary.wasm`) are the baseline for the C side of the conformance
matrix. They are migrated into the conformance tree during Step 1 and paired
with Rust equivalents during Step 3.

## Package Validation Requirements

Every compatibility feature that becomes part of the shared ABI must satisfy
five proof paths:

- a C canary built via `codepod-cc`
- a Rust canary built via `cargo-codepod`
- a shared behavioral spec both canaries pass
- an implementation-signature check confirming the compat body is linked
- at least one real package or tool using it, **in each language**

For this feature the named real consumers are:

- **C**: BusyBox (already under port; uses Tier 1 `signal`, `raise`, `dup2`,
  `getgroups`), built via `codepod-cc`.
- **Rust**: `packages/coreutils/` — codepod's existing Rust coreutils build
  — which exercises `signal`, `dup2`, and filesystem/stdio paths. Plus an
  **unmodified** third-party CLI crate (e.g. `fd`, `ripgrep`, or a
  `signal-hook`-using utility) built via `cargo-codepod` with no Cargo.toml
  patches — the load-bearing test that the wrapper model actually delivers
  transparent integration.

"Validates" means: the real consumer builds with the platform-provided
wrapper, passes its own test suite in a codepod sandbox, and its produced
`.wasm` passes the implementation-signature check.

This validation is part of the feature definition, not cleanup.

## Repository Shape

The repository evolves to this shape in Step 1:

- `packages/guest-compat/` (renamed from `packages/c-compat/`)
  - `include/` — public C headers
  - `src/` — C sources compiled into `libcodepod_guest_compat.a`
  - `toolchain/codepod-cc/` — clang wrapper (Rust binary, modeled on
    `wasixcc`), plus companion `codepod-ar` / `codepod-ranlib` /
    `codepod-cxx` as needed
  - `toolchain/cargo-codepod/` — cargo subcommand (Rust binary, modeled
    on `cargo-wasix`)
  - `rust/codepod-guest-compat-sys/` — optional `-sys` crate for
    codepod-authored guests that want to build under plain `cargo build`
  - `rust/codepod-guest-compat/` — optional safe-wrapper crate
  - `conformance/` — spec files, C canaries, Rust canaries, driver
- `packages/c-ports/` — C-specific port recipes (BusyBox etc.). Legacy
  canaries migrate into `packages/guest-compat/conformance/c/` during
  Step 1.
- `packages/rust-ports/` — Rust-specific port recipes (created in Step 3).
  Each port is a directory containing only the port manifest and any
  source patches; the upstream crate is fetched/vendored at build time
  and built via `cargo-codepod` without workspace wrapping.
- `scripts/run-guest-compat-conformance.sh` — conformance driver.

There is no `build-c-port.sh` / `build-rust-port.sh` — those roles are
absorbed by `codepod-cc` and `cargo-codepod`.

The architectural boundary is: one shared runtime archive, two symmetric
language frontends, delivered as two symmetric driver wrappers.

## Migration Path

Steps 1–2 are sequential. Step 3 splits into substeps that can parallelize
with Step 4; everything converges at Step 5.

### Step 1: Rename, stabilize, wrap clang

- Rename `packages/c-compat/` → `packages/guest-compat/`.
- Stabilize the Tier 1 semantics currently prototyped there.
- Ship `libcodepod_guest_compat.a` as the compiled artifact.
- Build `codepod-cc` and companion tools, wrapping the current C build
  flow. The existing C consumers (BusyBox etc.) migrate to invoking
  `codepod-cc` instead of raw `clang`.
- Introduce the conformance tree and migrate existing C canaries into it.

### Step 2: Reframe documentation

- Update headers and referenced specs to use "guest compatibility
  runtime" language.
- Update `2026-04-19-c-abi-compatibility-design.md` to cross-reference
  this document for architectural direction.

### Step 3 (parallelizable with Step 4)

- **3a**: Author the behavioral spec files for all Tier 1 symbols.
- **3b**: Build `cargo-codepod`, including RUSTFLAGS injection, version
  check, `wasm-opt` post-processing, and toolchain-download bootstrap.
- **3c**: Build the optional `codepod-guest-compat-sys` and
  `codepod-guest-compat` crates.
- **3d**: Port existing C canaries to paired Rust canaries under the
  conformance tree.
- **3e**: Wire the conformance driver and implementation-signature check
  into CI, exercising both wrappers.

### Step 4 (parallelizable with Step 3)

- Validate the BusyBox port against stabilized Tier 1, built via
  `codepod-cc`.
- Begin the first real Rust consumer port (`packages/coreutils/`) via
  `cargo-codepod` once 3b lands.

### Step 5: Real-consumer validation gate

- All named real consumers pass their own suites under the shared runtime:
  - BusyBox via `codepod-cc`
  - `packages/coreutils/` via `cargo-codepod`
  - at least one unmodified third-party Rust CLI via `cargo-codepod`
- The implementation-signature check is green for every Tier 1 symbol in
  every real consumer `.wasm`.

Only after Step 5 does evaluation of Phase B / Tier 3 begin.

## Risks

### Semantic Drift

Risk: C and Rust integrations diverge in behavior.

Mitigation: shared compiled archive, shared behavioral spec, paired
canaries, implementation-signature check in CI.

### Overbroad Compatibility Claims

Risk: codepod accidentally starts implying full POSIX or full Unix
behavior.

Mitigation: explicit tiering, explicit non-goals, each blessed symbol
documented individually with its failure modes.

### Toolchain Fragility

Risk: Rust transparent integration becomes brittle too early.

Mitigation: defer Phase B (custom target, deeper std/libc work) until
Phase A is validated. Phase A uses the stable `wasm32-wasip1` target and
`RUSTFLAGS` link-arg injection via `cargo-codepod`; no `-Z build-std`, no
forked rustc, no custom target JSON. The wrapper model is well-trodden
(precedent: `cargo-wasix`, `cargo-risczero`, `cargo-contract`).

### Recipe Pollution

Risk: compatibility work continues to leak into package-local shims
instead of the shared runtime.

Mitigation: any portability fix likely to recur must be promoted into
the shared guest compat runtime or explicitly rejected as non-portable.
The conformance tree is the single place Tier 1 semantics are defined.

### Link-Order Regressions

Risk: a future change to the C or Rust builder silently drops
`--whole-archive` and weak libc symbols start winning again.

Mitigation: the implementation-signature check in CI (§Verifying Precedence)
fails loudly the moment this happens.

## Acceptance Criteria

This feature is successful when all of the following are true:

- codepod has a written platform spec for a shared guest compatibility ABI
  (this document).
- `packages/c-compat/` has been renamed to `packages/guest-compat/` and
  hosts both C and Rust frontends side by side.
- The shared runtime ships as `libcodepod_guest_compat.a` and is linked
  with `--whole-archive` semantics by both frontends in Phase A.
- Two driver wrappers exist and are the supported entry points:
  `codepod-cc` (wraps clang, analogous to `wasixcc`) and `cargo-codepod`
  (cargo subcommand, analogous to `cargo-wasix`). Both are developed and
  released together from `packages/guest-compat/toolchain/`.
- The Tier 1 symbol set is identical in both frontends, with paired C and
  Rust canaries passing a shared behavioral spec.
- The implementation-signature check confirms that for every Tier 1 symbol
  in every canary and every real-consumer `.wasm`, the compat
  implementation is what is linked (and not a libc stub).
- The named real consumers — BusyBox built via `codepod-cc`,
  `packages/coreutils/` built via `cargo-codepod`, and at least one
  **unmodified** third-party Rust CLI crate built via `cargo-codepod` —
  pass their own suites against the shared runtime.
- The repository structure and docs make clear that compatibility is a
  platform feature, not a C-only subsystem, and that C and Rust are equal
  frontends.

## Relationship To Existing Specs

This document does not replace the C ABI compatibility spec. It extends it.

- `2026-04-19-c-abi-compatibility-design.md` remains the normative contract
  for current C-facing capability and conformance details.
- This document defines the architectural direction that promotes that work
  into a shared guest compatibility runtime spanning both C and Rust as
  first-class frontends.

If there is any conflict, this document controls architecture, toolchain
direction, and Tier 1 membership, while the C ABI spec controls current
low-level capability wording until that wording is updated to match the
shared-runtime model.
