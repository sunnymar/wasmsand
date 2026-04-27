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
- **One guest binary per port.**  No `<name>.wasm` /
  `<name>-threads.wasm` split.  Every binary cpcc emits links the
  same `libcodepod_guest_compat.a`, declares its memory `shared`,
  and resolves its pthread surface via `codepod::host_*` imports.
  The portability of WebAssembly is preserved end-to-end.
- **Backend-routed threading semantics.**  The `codepod::host_*`
  imports are the seam between the uniform frontend and the
  per-backend implementation.  cooperative-serial backends
  implement them as inline-invoke + no-op locks; wasi-threads /
  Worker+SAB backends implement them as native parallelism +
  futex/Atomics.wait.
- **Real concurrency on wasi-threads-capable runtimes.**  wasmtime
  is the headline real-thread backend for the Big Boss CPython use
  case; Worker+SAB delivers the same on browsers when COOP/COEP
  is available.
- **Cooperative correctness on every other runtime.**  Asyncify
  (Safari) and JSPI-without-SAB (Deno, no-COEP browsers) get the
  cooperative-serial backend: pthread_create runs inline, mutex /
  cond are no-ops.  The guest cannot tell except via timing.
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

## Approach: Single Binary, Backend-Routed Threading

The guest sees one `.wasm` regardless of backend — that's the whole
portability proposition of WebAssembly.  We do not ship per-backend
flavors of CPython, Rayon-using crates, or BusyBox.  Instead, the
divergence lives entirely on the host side:

- The guest binary always imports a shared memory and links the
  same `libcodepod_guest_compat.a` with pthread Tier 1 symbols.
  Those symbols thunk through codepod-private host imports
  (`codepod::host_thread_spawn`, `host_mutex_lock`, `host_cond_wait`,
  …) — they do not call wasi-threads imports directly.
- Each backend implements those host imports differently:
  - **Cooperative-serial** (Asyncify, JSPI) — `host_thread_spawn`
    runs the start_routine inline; mutex/cond are no-ops; serialized
    execution.  Always-available baseline.
  - **wasi-threads** (wasmtime, future component-model runtimes) —
    `host_thread_spawn` triggers a real wasi-thread that runs the
    start_routine pointer against the shared memory; mutex/cond
    use native futex ops.
  - **Worker+SAB** (browser/Chromium, browser/WebKit when SAB +
    COOP/COEP are available) — host spawns a Worker, shares
    `WebAssembly.Memory({shared:true})`, schedules the start_routine
    on it; mutex/cond use `Atomics.wait`/`Atomics.notify`.

Shared memory in the binary is benign on single-threaded backends —
the runtime hands back a SAB-or-equivalent and only one OS thread
ever touches it.  Real-thread backends contend on the same memory.

**Considered and rejected:**

- **Two-binary flavors (`<name>.wasm` + `<name>-threads.wasm`).**
  Breaks portability and forces every port to build twice.
- **Refuse to load on backends without real threads.**  Browser
  pages frequently lack COOP/COEP; refusing breaks the "load codepod
  and it works" contract.
- **Always-emulate, never use real wasi-threads.**  Defeats the
  Big Boss CPython parallelism goal and wastes hardware on wasmtime.

### Optional fast-path (deferred)

The pthread frontend could probe a `host_thread_caps()` import once
at init and short-circuit `mutex_lock/unlock` to inline no-ops when
the backend reports cooperative-serial.  Saves the Rust→JS→Rust hop
but removes the host call's natural yield point — net effect on
cooperative-correctness is non-trivial.  Profile-driven; not in the
initial cut.

## Architecture

### Frontend / Backend separation

```
guest .wasm  ──── pthread_create  ──── codepod_pthread.c  ─┐
                  pthread_mutex_lock                       │
                  ...                                      │
                                                           ▼
                                                   codepod::host_thread_spawn
                                                   codepod::host_mutex_lock
                                                   codepod::host_cond_wait
                                                   ...   (the seam)
                                                           │
            ┌──────────────────────────┬─────────────────┬─┴──────────────────┐
            ▼                          ▼                 ▼                    ▼
      Cooperative-Serial         wasi-threads     Worker+SAB           WASI Preview 2
      (Asyncify / JSPI)          (wasmtime)       (browser SAB)        (component model)
       inline-invoke              real OS         Worker per           runtime-defined
       no-op mutex                threads         pthread + SAB        threading interface
       serialized                 native futex    Atomics.wait
```

**Frontend** is what guest code links against — uniform, single binary
per port:

- `pthread.h` Tier 1 surface (struct layouts, function signatures
  pinned)
- `libcodepod_guest_compat.a` ships `codepod_pthread.c` whose bodies
  thunk through `codepod::host_*` imports
- Memory is always declared shared in the linked binary (`-pthread`
  is the default cpcc flag) — single-threaded backends just hand
  back a non-contended SAB
- No backend-specific `#ifdef`s in the frontend.  No `-threads`
  binary flavor.

**Backend** is the host implementation of the `codepod::host_*`
threading imports.  Each codepod runtime ships one or more.  The
only invariant a backend must uphold:

- `host_thread_spawn(start_fn_ptr, arg)` returns a thread id and
  schedules `start_routine(arg)` to run *eventually* — same memory,
  same indirect function table — and yields the caller through the
  usual host import suspend point
- `host_thread_join(tid)` resolves once the spawned routine returns,
  hands back its return value
- `host_mutex_lock/unlock` enforce mutual exclusion *if* the backend
  has more than one OS thread; otherwise they are correctness no-ops
- `host_cond_wait/signal/broadcast` enforce the wait-and-wake
  contract; on cooperative-serial backends a guest that reaches
  `cond_wait` with no signaler available is treated as spuriously
  woken (POSIX permits this)

### Backend matrix

| Backend | Async wrap | Threading | Availability | Yield point |
|---------|-----------|-----------|--------------|-------------|
| **Cooperative-Serial / Asyncify** | binaryen `--asyncify` | inline-invoke serialized | Safari/WebKit, any runtime without JSPI | every host import suspends |
| **Cooperative-Serial / JSPI** | `WebAssembly.Suspending` | inline-invoke serialized | Chromium ≥137, Deno, Node ≥25 | every host import suspends |
| **wasi-threads** | native | real wasi-threads | wasmtime; future component-model runtimes that ship the `wasi:thread_spawn` interface | OS preemption; host import is also a yield |
| **Worker+SAB** | JSPI per Worker, scheduler in main | real shared-memory threads via Workers | browser/Chromium and browser/WebKit when `crossOriginIsolated && SharedArrayBuffer && Worker` | OS preemption (Worker on its own thread) |
| **WASI Preview 2** | component-model imports | depends on the runtime's threading interface | research target (wasmtime-component, jco) | TBD |

### Backend selection at sandbox boot

```ts
detectThreadsBackend(adapter, runtime):
  if (runtime === 'wasmtime')                    return WasiThreadsBackend
  if (crossOriginIsolated && SharedArrayBuffer)  return WorkerSabBackend
  // fall back to cooperative-serial; the bridge type (asyncify vs JSPI)
  // is a separate decision, made by detectAsyncBridge()
  return CooperativeSerialBackend
```

The threading backend lives in `packages/orchestrator/src/process/threads/`
and registers itself into the `codepod::host_*` import namespace
*alongside* the existing `host_spawn` / `host_waitpid` / etc. imports.
Same import table, more entries.

### CPython implications

CPython's `Modules/_threadmodule.c` calls `pthread_create` /
`pthread_join` / `pthread_mutex_*` / `pthread_cond_*`.  No source
changes needed.  On cooperative-serial backends the impl serializes
(matches the single-threaded `wasm32-wasip1` build's behavior) and
`os.cpu_count()` reports 1; on wasi-threads or Worker+SAB it
parallelizes and reports the host count.

### Rayon implications

Rayon calls `std::thread::available_parallelism()` and
`std::thread::spawn` against the same pthread frontend.  Single
binary, parallel where the backend allows; correct-but-serial
elsewhere.  No `par_iter` feature flags or Cargo gymnastics.

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

Each step has its own acceptance gate.  Steps 1–2 land the frontend
and the cooperative-serial backend (always-available baseline).
Steps 3–5 add the real-thread backends — wasi-threads first because
it's the simplest to wire (wasmtime exposes it natively), then
Worker+SAB for browsers, then WASI Preview 2 if/when its threading
story matures.  Step 6 ports CPython.  Step 7 is the Rayon
cross-backend acceptance gate.

### Step 1 — pthread frontend + cooperative-serial backend

- Add `pthread.h`, `threads.h`, `semaphore.h` to
  `packages/guest-compat/include/`
- Add `codepod_pthread.c` to `packages/guest-compat/src/` — every
  Tier 1 symbol thunks through `codepod::host_*` imports.  No
  inline shortcuts; the host import path *is* the implementation.
- Add the threading host-import surface in
  `packages/orchestrator/src/host-imports/kernel-imports.ts`:
  `host_thread_spawn`, `host_thread_join`, `host_thread_detach`,
  `host_thread_self`, `host_thread_yield`, `host_mutex_lock`,
  `host_mutex_unlock`, `host_mutex_trylock`, `host_cond_wait`,
  `host_cond_signal`, `host_cond_broadcast`.  Same JSPI/Asyncify
  wrapping as the rest of the kernel imports.
- Add `packages/orchestrator/src/process/threads/cooperative-serial.ts`
  implementing the host imports as inline-invoke + no-op
  mutex/cond.  Single OS thread; correctness via serialization.
- TIER1 in cpcc grows to include the pthread Tier 1 list.
- Acceptance: a C canary in `packages/guest-compat/conformance/c/`
  spawns 4 threads, each increments a shared counter under mutex
  10000 times, joins all four, asserts counter == 40000.  Same
  canary as a Rust binary using `std::thread::spawn`.  Both pass on
  the cooperative-serial backend.

### Step 2 — backend selection plumbing

- Add `ThreadsBackend` interface in
  `packages/orchestrator/src/process/threads/backend.ts` exposing
  the host-import surface as a TypeScript contract.
- `Sandbox.create()` calls `detectThreadsBackend(adapter, runtime)`
  and wires the result into `createKernelImports({ threadsBackend })`.
- For now `detectThreadsBackend` always returns
  `CooperativeSerialBackend`; subsequent steps add the real-thread
  backends behind feature flags.
- Acceptance: same Step 1 canary; the threading host imports are
  resolved via the `ThreadsBackend` indirection rather than directly
  bound — the Step 1 canary still passes unchanged.

### Step 3 — wasi-threads backend (wasmtime)

- Add `packages/orchestrator/src/process/threads/wasi-threads.ts`
  (or, for the Rust sandbox-server, the wasmtime-side equivalent
  in `packages/sdk-server-wasmtime/`).
- `host_thread_spawn` calls into wasmtime's wasi-threads spawn,
  passing the start_routine pointer + arg + the shared memory.
- `host_mutex_lock/unlock` use atomic CAS + futex_wait/wake on the
  pthread_mutex_t opaque storage.  `host_cond_*` similarly.
- `detectThreadsBackend` selects `WasiThreadsBackend` when running
  on wasmtime.
- The guest binary is unchanged from Step 1 — same .wasm, different
  host import implementation.
- Acceptance: the Step 1 pthread canary on wasmtime shows real
  parallelism (4 threads contending on a mutex at ~4× single-thread
  throughput).  `pthread_self()` returns distinct ids per thread.

### Step 4 — Worker+SAB backend (browser)

- Add `packages/orchestrator/src/process/threads/worker-sab.ts`.
- BrowserAdapter checks `crossOriginIsolated && SharedArrayBuffer
  && Worker` and reports threading capability up to
  `detectThreadsBackend`.
- `host_thread_spawn` posts the start_routine pointer + arg to a
  fresh Worker that holds a shim for the same WASM module
  instantiated against the shared `WebAssembly.Memory({shared:true})`.
  Each Worker has its own JSPI/Asyncify bridge for host imports.
- `host_mutex_*` use `Atomics.wait/notify` on the shared memory.
- Same .wasm again — only the host imports differ.
- Acceptance: same canary, browser test with COOP/COEP headers,
  shows real parallelism on Chromium and WebKit.

### Step 5 — WASI Preview 2 backend (research)

- Survey the threading interfaces shipped by wasmtime-component
  and jco; design a `ThreadsBackend` over them if a viable surface
  exists.
- Optional/research-driven; cooperative-serial remains the fallback
  if WASI P2's threading story isn't ready by the time we need it.
- Acceptance: the same canary passes on a WASI P2 runtime, OR the
  decision to defer is documented with rationale.

### Step 6 — CPython port

- Add `packages/c-ports/cpython/` with submodule pinned to upstream
  CPython 3.13 (or current).  Build via cpcc; the binary works on
  every codepod backend.
- Acceptance: `python3 -c "import threading; t =
  threading.Thread(target=lambda: print('hi')); t.start(); t.join()"`
  prints `hi` and exits 0 on every backend.
  `python3 -c "import os; print(os.cpu_count())"` prints 1 on
  cooperative-serial, host-cpu-count on wasi-threads/Worker+SAB.

### Step 7 — Rayon canary as Rust port

- Add `packages/rust-ports/rayon-canary/` that uses Rayon's
  `par_iter().map().sum()` over a 1M-element vec, asserts result.
- Single binary; behavior varies by backend.
- Acceptance: builds + passes on every backend (serialized on
  cooperative-serial, parallelized on wasi-threads / Worker+SAB).

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
  mean the Worker+SAB backend (Step 4) only works in host pages
  that opt in.  Mitigation: cooperative-serial is the always-
  available browser fallback; the same .wasm runs on either path.
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
5. cpcheck (structural mode) confirms `libcodepod_guest_compat.a`
   exports all Tier 1 pthread symbols.  The guest binary imports
   `codepod::host_thread_spawn` etc. — *not* `wasi_thread_spawn` —
   confirming the backend-routing shape.

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
