/**
 * ThreadsBackend — host-side implementation of the codepod pthread
 * surface.  See
 * docs/superpowers/specs/2026-04-27-wasi-threads-design.md for the
 * frontend/backend split.
 *
 * The guest binary always calls `codepod::host_thread_*` and
 * `codepod::host_mutex_*` / `host_cond_*` imports — those imports
 * dispatch into this interface.  Each codepod runtime selects a
 * backend at sandbox boot:
 *
 *   - CooperativeSerialBackend — Asyncify or JSPI; inline-invoke +
 *     no-op locks; always-available baseline.
 *   - WasiThreadsBackend       — wasmtime native; real parallelism.
 *   - WorkerSabBackend         — browser SAB+Worker; real parallelism.
 *   - WasiPreview2Backend      — research target.
 *
 * The interface is async because real-thread backends suspend on
 * join/cond_wait; cooperative-serial backends still return Promises
 * so the kernel-imports glue can wrap them uniformly with JSPI's
 * Suspending/promising machinery.
 */

import type { IndirectCallTable } from './indirect-call-table.js';

export interface ThreadsBackend {
  readonly kind: 'cooperative-serial' | 'wasi-threads' | 'worker-sab' | 'wasi-p2';

  /**
   * Wire the backend to the guest's indirect function table.  Called
   * once after the wasm instance is created — the proxy over
   * `instance.exports.__indirect_function_table` lets the backend
   * dispatch start_routine pointers back into the guest.  No-op on
   * backends that don't need to call back into wasm directly
   * (e.g. wasi-threads, where the runtime owns dispatch).
   */
  setIndirectCallTable(table: IndirectCallTable): void;

  /**
   * `pthread_create` thunk: schedule start_routine(arg) and return a
   * thread id.  Cooperative-serial backends inline-invoke
   * start_routine via the indirect call table; real-thread backends
   * dispatch to a fresh wasi-thread or Worker.  Returns -1 on failure.
   */
  spawn(fnPtr: number, arg: number): Promise<number>;

  /**
   * `pthread_join` thunk: suspend until the named thread completes,
   * then return the start_routine's return value (cast to int).
   * Returns -1 if tid is invalid or already reaped.
   */
  join(tid: number): Promise<number>;

  /** `pthread_detach` thunk.  Returns 0 on success, -1 on invalid id. */
  detach(tid: number): Promise<number>;

  /** `pthread_self` thunk.  Returns the current thread id. */
  self(): number;

  /** `pthread_yield` / `sched_yield` thunk.  Always returns 0. */
  yield_(): Promise<number>;

  /** `pthread_mutex_lock` thunk.  Pointer is into wasm linear memory. */
  mutexLock(mutexPtr: number): Promise<number>;

  /** `pthread_mutex_unlock` thunk. */
  mutexUnlock(mutexPtr: number): number;

  /** `pthread_mutex_trylock` thunk. */
  mutexTryLock(mutexPtr: number): number;

  /** `pthread_cond_wait` thunk.  Releases mutex, suspends, re-acquires. */
  condWait(condPtr: number, mutexPtr: number): Promise<number>;

  /** `pthread_cond_signal` thunk. */
  condSignal(condPtr: number): number;

  /** `pthread_cond_broadcast` thunk. */
  condBroadcast(condPtr: number): number;
}
