# codepod WASI Threads + pthread Surface

## Status

Draft, design phase.  No code merged.  Target consumers: CPython
(`wasm32-wasi-threads` build), Rust crates that use `std::thread` /
`Rayon`, BusyBox optional thread-using applets, future C ports that
configure with `--enable-threads`.

This document is the threads counterpart to
[`2026-04-19-guest-compat-runtime-design.md`](./2026-04-19-guest-compat-runtime-design.md):
guest-compat covers single-threaded POSIX surface; this spec extends
the compat ABI with the pthread / atomics / TLS surface and defines
how each codepod backend implements it.

The implementation is iterative per the same Migration Path pattern
as guest-compat — Step 1 is a stand-alone deliverable with its own
acceptance gate, Step 2 builds on it, etc.

## Outcome

Target end state — for any guest binary built against the codepod
guest-compat runtime with threads enabled (CPython, a Rust crate
using `std::thread::spawn` / Rayon, or a C port linked with
`-pthread`):

- the binary builds *unchanged* against codepod's pthread headers
- the binary links and instantiates on every backend codepod ships
  (wasmtime, deno, browser/Chromium, browser/WebKit)
- it executes correctly — no deadlocks, no UB from atomics or TLS
- on backends that can deliver real concurrency (wasmtime today;
  browser via Worker+SAB tomorrow if we choose), the binary actually
  parallelizes
- on backends that cannot (today: browser cooperative, deno cooperative),
  the binary still completes correctly with serialized execution; only
  observable difference is wall-clock speedup

The product requirement is **API + semantic equivalence**, not
identical performance.  Real concurrency is a backend-by-backend
property the runtime advertises (`sysconf(_SC_NPROCESSORS_ONLN)`,
`std::thread::available_parallelism()`); guest code that respects it
sees no surprises.  Guest code that *ignores* it (e.g. assumes
`pthread_create` always means real parallelism) still functions —
just slower.

## Problem

Three concrete blockers today:

**1. CPython requires threads.**  CPython's `wasm32-wasi-threads`
configuration is the path with the most upstream maintenance (the
threadless build is increasingly second-class — `import sqlite3`,
`asyncio`, `concurrent.futures`, the `gc` module's finalizer thread,
and several C-extension bindings all assume `pthread_create` works).
Big Boss for codepod is "build CPython for codepod"; without threads
we either fork CPython or accept perpetual incompatibility with the
upstream wasm story.

**2. Rust crates assume `std::thread`.**  Rayon's `par_iter` is the
canonical example: it spawns N OS threads and rebalances work units
across them.  On a single-threaded WASI build it serializes, but on
`wasm32-wasi-threads` it expects real cores.  Outside Rayon: any
Rust crate that uses `crossbeam`, `tokio` (multi-thread runtime),
`mio`, or `std::sync::mpsc` will at minimum *link* against pthread
symbols even if it doesn't actually go parallel.

**3. The codepod runtime has typed-stub plumbing but no implementation.**
`packages/orchestrator/src/async-bridge.ts` declares a `'threads'`
mode in the `AsyncBridgeType` union with `binarySuffix: '-threads'`
and `sharedMemory: true`; `ThreadsAsyncBridge.wrapImport/wrapExport`
both throw `'not yet implemented'`.  The shape is committed but the
guts are empty.  And on the guest side, `packages/guest-compat/include/`
ships no `pthread.h` at all — the README explicitly disclaims
"portable pthread guarantees."

The non-blockers we are explicitly *not* trying to solve:

- preemptive scheduling on JS-runtime backends (impossible — JS is
  cooperative; once a Worker is in a tight loop it doesn't yield)
- raw pthread *signal* delivery (`pthread_kill`, `sigaction` per-thread)
  — single-threaded guest-compat already half-stubs signals; we'll
  extend rather than rebuild
- deep synchronization primitives that aren't backed by host atomics
  (e.g. process-shared mutexes, robust mutexes, priority inheritance) —
  return ENOTSUP at the API boundary

## Goals

- **One pthread header set** under `packages/guest-compat/include/`
  (`pthread.h`, `sys/pthread.h`, `pthread_impl.h` if the wasi-libc
  internal headers need shadowing).  Same headers serve all backends;
  ABI / struct layout is fixed.
- **One `wasm32-wasi-threads` build target** for guest binaries.
  Source code is unchanged; the *binary* differs (atomics + shared
  memory).  cpcc grows a `--threads` flag that flips the target +
  links the threads-flavored compat archive.
- **Real concurrency on wasmtime.**  wasmtime has native wasi-threads;
  we wire it through unchanged.  This is the headline backend for
  the Big Boss CPython use case.
- **Cooperative correctness on browser + deno.**  Threads exist as a
  scheduling abstraction over the JSPI/Asyncify event loop: each
  `pthread_create` creates a logical thread that the runtime
  multiplexes onto the single guest instance.  No real parallelism;
  the guest cannot tell the difference except via timing.
- **`available_parallelism()` honesty.**  Backends report the real
  number of cores available to guest code.  wasmtime: host CPU count.
  Browser/deno cooperative: 1.  Browser with Worker+SAB upgrade
  path: configurable.  This lets Rayon and CPython's `os.cpu_count()`
  size their pools correctly.
- **Atomics correctness.**  Whether real or simulated, every atomic
  op the guest performs must be observable to other guest threads in
  program order.  On wasmtime this is the WASM atomics proposal; on
  cooperative backends it's trivial (single OS thread = no races) but
  the *appearance* must hold across yield points.

## Non-Goals

- Process-shared mutexes (`PTHREAD_PROCESS_SHARED`) — return ENOTSUP.
- Per-thread signal delivery (`pthread_kill`, `pthread_sigmask` with
  per-thread effect).  Signals stay process-wide.
- Priority scheduling (`SCHED_RR`, `SCHED_FIFO`, `pthread_setschedparam`)
  — accept silently, no-op.
- `pthread_cancel` — return ENOTSUP.  Cancellation is too entangled
  with the cooperative-vs-preemptive split; not needed for CPython
  or Rayon.
- Promoting deno from cooperative to Worker+SAB unless user demand
  appears.  Deno is dev-only by codepod's positioning today.
- Browser's SAB upgrade path is *scoped in* but not Step 1; cooperative
  semantics on browser is the immediate deliverable.

## Design Approaches

### A. Real-wasi-threads everywhere, refuse where impossible

Build `codepod-shell-exec-threads.wasm` once (atomics + shared memory).
On wasmtime: instantiate as wasi-threads.  On browser/deno: detect SAB
+ Worker availability, fall back with an *error at instantiation* if
threads aren't possible.  Guest binary is the same on every backend.

**Pro:** simplest binary story; no per-backend wasm flavors.
**Con:** Browser-without-COOP/COEP and Deno-without-`--allow-worker`
are common configurations (and the COOP/COEP requirement is a
deal-breaker for embedding codepod in arbitrary host pages).  Refusing
to instantiate breaks the "load codepod and it works" promise.

### B. Two binaries, runtime-selected (chosen)

Ship two flavors per guest binary: `<name>.wasm` (single-threaded,
no shared memory) and `<name>-threads.wasm` (atomics, shared memory,
wasi-threads imports).  Backend selects:

- wasmtime: load `-threads` flavor; wire to wasmtime's wasi-threads
- browser+SAB+COOP-COEP: load `-threads` flavor; spawn one Worker
  per logical pthread, share `WebAssembly.Memory({shared:true})`
- browser without SAB: load single-threaded flavor; pthread API is
  shimmed via cooperative scheduling
- deno: same default as browser without SAB

**Pro:** single-threaded path is unaffected for users who don't need
threads; threads path is real where it can be.  No instantiation
surprise.
**Con:** two binary artifacts per port; build complexity doubles
(but: most ports don't need threads, so this scales by need rather
than by port count).

### C. Always emulate, never use real wasi-threads

Single binary, single guest instance; cooperatively schedule pthreads
on the JSPI/Asyncify loop everywhere.

**Pro:** trivial; one code path.
**Con:** defeats the whole point — no parallelism *anywhere*, even
on wasmtime where it's free.  Big Boss CPython workload would be
single-threaded forever.  Not viable.

**Decision: B.**  Two-binary, runtime-selected.  C is the cooperative
fallback path inside B for backends that can't do real threads.

## Architecture

### Binary flavors

For each guest binary that wants threads:

```
<name>.wasm           single-threaded, standard wasm32-wasip1
<name>-threads.wasm   wasm32-wasi-threads:
                        - imports wasi_thread_spawn from "wasi"
                        - imports memory{shared:true, maximum:N}
                        - linked against libcodepod_guest_compat_threads.a
                          (pthread + atomics + TLS lowering)
```

Built by `cpcc --threads` (or `cpcc --target wasm32-wasi-threads`).
The single-threaded flavor is the default; ports opt in to the
threads flavor in their Makefile (CPython, future Rayon-using crates).

Tools without a `-threads.wasm` are loaded as today.  Tools with
both flavors get backend-selected by `Sandbox.registerTools` —
extends the manifest pass from `2026-04-19-guest-compat-runtime-design.md`
with a new `threads: { ... }` declaration:

```json
{
  "name": "python3",
  "threads": {
    "binary": "python3-threads.wasm",
    "minThreads": 1,
    "maxThreads": 64
  }
}
```

### Runtime backend selection

```
detectThreadsBackend():
  if (wasmtime native)              return WasmtimeNativeThreads
  if (SAB available && Worker available)
                                    return BrowserSharedMemoryThreads
  return CooperativeThreads
```

`AsyncBridge` already exposes `sharedMemory: boolean` per mode; the
threads backend selection happens *upstream* of bridge selection
because the binary flavor is determined first, then the bridge is
chosen for the host import calling convention.

### Per-backend implementation table

| Concern                | Wasmtime native | Browser SAB+Worker | Cooperative (browser-no-SAB / deno) |
|------------------------|-----------------|---------------------|-------------------------------------|
| Binary flavor          | `-threads`      | `-threads`          | single-threaded                     |
| Memory                 | shared, growable | `WebAssembly.Memory({shared:true})` shared across Workers | normal (per-instance) |
| `pthread_create`       | wasmtime spawns thread | host spawns Worker, posts module + memory + start fn ptr | host appends to ready queue |
| Thread switching       | OS preemption | OS preemption (Worker on its own thread) | guest cooperatively yields at JSPI suspend points |
| Atomics                | hardware       | hardware (SAB-backed) | trivial (single OS thread) |
| TLS                    | wasi-libc TLS, per wasi-thread | wasi-libc TLS, per Worker | switched by cooperative scheduler at yield |
| `pthread_join`         | OS join        | postMessage + Atomics.wait | scheduler resolves promise |
| Mutex                  | wasi futex     | `Atomics.wait` on SAB | cooperative — release at yield |
| `available_parallelism`| host CPU count | configurable (default = `navigator.hardwareConcurrency`) | 1 |

### Cooperative-multiplexing model

Cooperative threads run inside the *single* guest WASM instance.
The runtime maintains a ready queue of logical threads, each with:

- a stack region (allocated in WASM linear memory)
- saved register state (captured at the last yield point — same
  Asyncify save-state mechanism used today for setjmp/longjmp)
- a TLS pointer (cooperative scheduler swaps the TLS base register
  on context switch)

Yield points: every host import call (because they all go through
JSPI/Asyncify already), every `pthread_yield`, every `pthread_mutex_lock`
that contends, every `pthread_cond_wait`.  Tight loops with no host
calls do *not* yield — this is a known limitation, identical to the
single-threaded async constraint we already have.

Atomics are trivially correct because no two threads run at the same
time; the wasm atomics ops are free (single-OS-thread observability).

### CPython implications

CPython's `Modules/_threadmodule.c` calls `pthread_create` /
`pthread_join` / `pthread_mutex_*` / `pthread_cond_*`.  None of these
need source changes — the cooperative backend just makes them
slower (and reduces `os.cpu_count()` to 1 so `concurrent.futures`
sizes itself correctly).  CPython's GIL is a single mutex; cooperative
threads serialize naturally and the GIL becomes a no-op-ish.

### Rayon implications

Rayon calls `std::thread::available_parallelism()` (returns 1 on
cooperative backends → Rayon uses a 1-thread pool → serial execution,
correct but un-parallelized) and `std::thread::spawn` (cooperative
shim runs them serially).  No source changes; `par_iter` works,
just doesn't parallelize on cooperative backends.

## POSIX Surface

Headers added under `packages/guest-compat/include/`:

```
pthread.h          — pthread_t, pthread_create/join/detach/exit,
                     pthread_self, pthread_equal, pthread_yield,
                     mutex / cond / rwlock / spinlock APIs
                     (cancellation: pthread_cancel returns ENOTSUP)
sched.h            — already exists; extend with sched_yield real impl
                     and the SCHED_* constants (no-op setters)
sys/pthread.h      — wasi-libc compat shim if needed
threads.h          — C11 threads (thrd_create / mtx_*); thin wrappers
                     over pthread, useful for ports that want C11
stdatomic.h        — already provided by clang as __c11; we just
                     surface it.  All atomic ops lower to wasm atomics
                     in the threads binary, to plain ops in the
                     single-threaded binary
semaphore.h        — POSIX semaphores; Linux extension; back with
                     mutex+condvar
```

Symbols are real exports in `libcodepod_guest_compat_threads.a`
(linked `--whole-archive` by `cpcc --threads`), mirroring the
guest-compat Tier 1 pattern.  Single-threaded `libcodepod_guest_compat.a`
ships the *same* header set but with stub bodies that return ENOTSUP
where threads are required (so single-threaded builds still link
when source code references pthread symbols defensively but doesn't
exercise them — common in autoconf-built code).

### Tier 1 (must have, Step 1)

```
pthread_create, pthread_join, pthread_detach, pthread_exit,
pthread_self, pthread_equal,
pthread_mutex_init, pthread_mutex_destroy,
pthread_mutex_lock, pthread_mutex_unlock, pthread_mutex_trylock,
pthread_cond_init, pthread_cond_destroy,
pthread_cond_wait, pthread_cond_signal, pthread_cond_broadcast,
pthread_key_create, pthread_key_delete,
pthread_setspecific, pthread_getspecific,
pthread_once,
sched_yield
```

That's the surface CPython's `_threadmodule.c` and Rayon's
`crossbeam_utils` actually call.  Anything else (rwlocks, barriers,
spinlocks, attr setters beyond stack size) is Tier 2 — link as stubs
that return ENOTSUP, expand on demand.

### Tier 2 (on demand)

```
pthread_rwlock_*, pthread_barrier_*, pthread_spin_*,
pthread_attr_setdetachstate, pthread_attr_setstacksize,
pthread_attr_setguardsize, pthread_attr_setschedpolicy,
pthread_setname_np, pthread_getname_np,
pthread_setaffinity_np, pthread_getaffinity_np
```

## Migration Path

Each step has its own acceptance gate.  Steps 1–2 are cooperative-only
and unblock CPython-on-codepod with serialized threads.  Steps 3–4
add real parallelism.  Step 5 is browser-SAB which depends on
COOP/COEP being deployed in the host environment.

### Step 1 — pthread headers + cooperative scheduler stub

- Add `pthread.h`, `threads.h`, `semaphore.h` to
  `packages/guest-compat/include/`
- Add `codepod_pthread.c` to `packages/guest-compat/src/` providing
  Tier 1 symbols that route through new host imports:
  `host_thread_spawn(start_fn_ptr, arg)` →
    cooperative scheduler appends to ready queue
  `host_thread_yield()` →
    scheduler picks next ready thread
  `host_mutex_*`, `host_cond_*` →
    scheduler-side primitives
- Add cooperative scheduler to `packages/orchestrator/src/process/`
  (call it `cooperative-scheduler.ts`) that maintains the ready queue,
  context-switches at yield points, owns thread-local storage maps
- Single-binary build only (no `-threads.wasm` yet)
- TIER1 in cpcc grows to include the pthread Tier 1 list
- Acceptance: a C canary in `packages/guest-compat/conformance/c/`
  spawns 4 threads, each increments a shared counter under mutex
  10000 times, joins all four, asserts counter == 40000 with no
  races (trivial since they're cooperative).  Same canary as a
  Rust binary using `std::thread::spawn`.

### Step 2 — CPython single-threaded build with cooperative threads

- Add `packages/c-ports/cpython/` with submodule pinned to upstream
  CPython 3.13 (or current) `wasm32-wasi-threads` config
- Build via cpcc using the cooperative threads binary
- Acceptance: `python3 -c "import threading; t = threading.Thread(target=lambda: print('hi')); t.start(); t.join()"`
  prints `hi` and exits 0.  `python3 -c "import os; print(os.cpu_count())"`
  prints 1.

### Step 3 — wasi-threads binary flavor + cpcc --threads

- cpcc grows `--threads` flag → `--target=wasm32-wasi-threads`,
  links `libcodepod_guest_compat_threads.a`
- Build `libcodepod_guest_compat_threads.a` separately: same source
  as single-threaded archive but compiled with `-pthread -matomics`
  and the host-import bodies replaced with wasi-threads native ops
- Manifest schema gets `threads: { binary, minThreads, maxThreads }`
- Acceptance: a `-threads.wasm` of the Step 1 pthread canary builds
  cleanly; cpcheck (structural) confirms it imports `wasi_thread_spawn`.

### Step 4 — wasmtime native wasi-threads runtime

- `Sandbox.registerTools` selects `<name>-threads.wasm` over
  `<name>.wasm` when running on wasmtime AND the manifest declares
  threads support
- wasmtime sandbox-server backend wires wasi-threads through
  `wasmtime::component::Linker::add_to_linker` (or wasmtime-wasi
  equivalent)
- Acceptance: the Step 1 pthread canary, run as `-threads.wasm` on
  wasmtime, shows real parallelism (4 threads contending on a mutex
  at 4× the rate a single thread could).  `os.cpu_count()` in
  CPython-on-wasmtime returns the host count.

### Step 5 — browser SAB+Worker backend (optional, gated on demand)

- BrowserAdapter detects `crossOriginIsolated` + `SharedArrayBuffer` +
  `Worker` availability
- New `worker-pool.ts` spawns one Worker per pthread, shares the
  `WebAssembly.Memory({shared:true})` across them
- Asyncify or JSPI bridge per Worker for host import suspension
- Acceptance: same Step 4 canary, run in a browser test with
  COOP/COEP headers, shows real parallelism.

### Step 6 — Rayon canary as Rust port

- Add `packages/rust-ports/rayon-canary/` that uses Rayon's
  `par_iter().map().sum()` over a 1M-element vec, asserts result
- Verifies the Rust toolchain frontend picks up the threads flavor
  cleanly
- Acceptance: builds + passes on every backend (serialized on
  cooperative, parallelized on wasmtime/browser-SAB)

## Risks

- **Cooperative deadlock from blocking host imports.**  If a guest
  thread holds a mutex and calls a host import that suspends
  *without* yielding to the scheduler, other threads waiting on the
  mutex never get to run.  Mitigation: every host import is also a
  scheduler yield point (already true for JSPI/Asyncify; just need
  to wire the scheduler into the suspend path).
- **TLS context-switch cost on cooperative.**  Every yield rewrites
  the TLS base; for guests that thread-hop heavily this is N memory
  loads per switch.  Mitigation: profile after Step 2; if hot, batch
  yields.
- **wasi-libc TLS layout assumptions.**  wasi-libc's TLS is designed
  for OS threads; cooperative threads need to fake it.  Risk: subtle
  bugs from wasi-libc functions that read from "the current" TLS
  region without the scheduler having swapped it.  Mitigation: use
  `__wasilibc_set_tls_base` (or equivalent) at every context switch;
  the canary in Step 1 must include a stress test that hammers
  `errno` (TLS-stored) across thread boundaries.
- **wasmtime wasi-threads API churn.**  The wasi-threads proposal is
  still Phase 2/3; the wasmtime API for it has changed shape across
  versions.  Mitigation: pin wasmtime version, add a regression
  canary that fails CI if a version bump breaks the binding.
- **Browser SAB delivery is conditional.**  COOP/COEP requirements
  mean Step 5 only works in host pages that opt in.  Mitigation:
  Step 5 is explicitly gated on demand; cooperative is the default
  browser story until a real consumer needs SAB.
- **Rayon thread-pool sizing.**  Rayon caches `available_parallelism`
  at first call; if our cooperative backend reports 1, Rayon's pool
  is forever 1 even if the binary is later moved to a parallel
  backend.  Mitigation: this is correct behavior — the binary is
  built once, the pool sizes itself once, and the answer doesn't
  change at runtime within a single execution.

## Acceptance Criteria

The spec is implemented when:

1. Step 1 canary (4-thread mutex stress test in C and Rust) passes
   on all three backends (wasmtime, browser/Chromium, browser/WebKit).
2. CPython 3.13 `wasm32-wasi-threads` binary, built via codepod's
   cpcc, runs a `threading.Thread` smoke test on all three backends.
3. wasmtime backend runs the same canary at ≥3× the single-threaded
   wall-clock (proof of real parallelism).
4. Cooperative backends never deadlock under the canary, even with
   intentionally pessimal scheduling (e.g. priority inversion patterns).
5. cpcheck (structural mode) confirms the threads-flavored compat
   archive exports all Tier 1 pthread symbols and the `-threads.wasm`
   imports `wasi_thread_spawn`.

## Relationship To Existing Specs

- **Extends:** `2026-04-19-guest-compat-runtime-design.md` — same
  ABI authority, same `--whole-archive` link discipline, same Tier
  taxonomy.  Threads are a new tier of the same compat runtime.
- **Extends:** `2026-04-19-c-abi-compatibility-design.md` — the
  pthread headers join the existing C ABI surface; struct layouts
  follow wasi-libc.
- **Compatible with:** `2026-03-26-lean-binary-native-bridge-design.md`
  — the cooperative scheduler is a "lean binary" pattern (no
  separate worker per thread); wasmtime + SAB backends are the
  "native" path.
- **No conflict with:** the manifest install pattern from this PR
  (#6) — threads gets a new `threads:` manifest key but doesn't
  alter the manifest discovery / apply mechanism.
