/**
 * CooperativeSerialBackend — the always-available threads backend.
 *
 * Runs every spawned start_routine inline (re-entrant wasm call via
 * the indirect function table) and returns the result through the
 * spawn id ledger.  Mutex / cond are correctness no-ops because
 * execution is single-OS-thread — no other thread can be waiting
 * for or holding the lock.
 *
 * The "host call is the yield point" property is preserved: every
 * pthread_create / pthread_join / pthread_mutex_lock / pthread_cond_*
 * goes through a host import that the JSPI/Asyncify bridge wraps,
 * so the wasm side suspends and the JS event loop runs other
 * promises (network fetches, child process I/O, etc.) before
 * returning to the guest.
 */

import type { ThreadsBackend } from './backend.js';
import type { IndirectCallTable } from './indirect-call-table.js';
import { NULL_INDIRECT_CALL_TABLE } from './indirect-call-table.js';

interface SpawnSlot {
  /** Resolved with the start_routine's i32 return value once it
   *  completes.  Pre-resolved on cooperative-serial (we run inline). */
  result: Promise<number>;
  /** Whether pthread_join has consumed this slot. */
  reaped: boolean;
  /** Detached threads auto-free; their join calls return -1. */
  detached: boolean;
}

export class CooperativeSerialBackend implements ThreadsBackend {
  readonly kind = 'cooperative-serial' as const;

  /** Per-process slot table.  Slot 0 reserved for the main thread
   *  so pthread_self() returns a stable id during early startup. */
  private slots: SpawnSlot[] = [];
  private indirectTable: IndirectCallTable = NULL_INDIRECT_CALL_TABLE;

  setIndirectCallTable(table: IndirectCallTable): void {
    this.indirectTable = table;
    if (this.slots.length === 0) {
      // Reserve slot 0 for the main thread.
      this.slots.push({
        result: Promise.resolve(0),
        reaped: true,
        detached: false,
      });
    }
  }

  async spawn(fnPtr: number, arg: number): Promise<number> {
    if (this.slots.length === 0) {
      // setIndirectCallTable hasn't been called yet — guard so the
      // very first spawn isn't lost in an unwired state.
      this.slots.push({ result: Promise.resolve(0), reaped: true, detached: false });
    }
    const tid = this.slots.length;
    // Inline-invoke: the start_routine runs to completion as part
    // of this spawn call.  re-entrant wasm via JSPI promising.
    let result: Promise<number>;
    try {
      result = this.indirectTable.call(fnPtr, arg);
    } catch {
      // Indirect call setup failed (e.g., fnPtr out of bounds, or the
      // backend's call table wasn't wired before pthread_create ran).
      // Surface as -1 so the C frontend returns EAGAIN.
      return -1;
    }
    this.slots.push({
      result,
      reaped: false,
      detached: false,
    });
    // Await here so the spawn host import doesn't return until the
    // thread function has finished — that's the cooperative-serial
    // contract (every spawn is also a join from the caller's POV).
    try {
      await result;
    } catch {
      // start_routine threw or trapped — treat the spawn as failed.
      return -1;
    }
    return tid;
  }

  async join(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped || slot.detached) return -1;
    slot.reaped = true;
    return slot.result;
  }

  async detach(tid: number): Promise<number> {
    const slot = this.slots[tid];
    if (!slot || slot.reaped) return -1;
    slot.detached = true;
    slot.reaped = true;  // can't be joined; free the slot
    return 0;
  }

  self(): number {
    // Cooperative-serial: only one logical thread is ever "active"
    // at a given moment (the inline-invoke contract).  Returning
    // the most-recently-spawned slot is a reasonable approximation
    // for guest code that asks; main-thread callers see slot 0.
    return Math.max(0, this.slots.length - 1);
  }

  async yield_(): Promise<number> {
    // The host import call itself is the yield point — JSPI
    // suspends, the event loop runs, then we return.  Nothing
    // explicit to do here.
    return 0;
  }

  async mutexLock(_mutexPtr: number): Promise<number> {
    // Single OS thread → no contention possible → uncontended take.
    return 0;
  }

  mutexUnlock(_mutexPtr: number): number {
    return 0;
  }

  mutexTryLock(_mutexPtr: number): number {
    return 0;
  }

  async condWait(_condPtr: number, _mutexPtr: number): Promise<number> {
    // POSIX permits spurious wakeups; under cooperative-serial the
    // wait can never be satisfied (no other thread to signal), so
    // immediately return as if spuriously woken — guest code that
    // wraps cond_wait in the canonical `while (!predicate)` loop
    // will simply spin (and yield via this very import each time).
    return 0;
  }

  condSignal(_condPtr: number): number {
    return 0;
  }

  condBroadcast(_condPtr: number): number {
    return 0;
  }
}
