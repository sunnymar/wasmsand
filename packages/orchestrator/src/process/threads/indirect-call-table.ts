/**
 * IndirectCallTable — typed handle on the guest's
 * `__indirect_function_table` export.  Used by ThreadsBackend
 * implementations that need to call start_routine pointers back
 * into the guest (cooperative-serial does inline-invoke; wasi-
 * threads and Worker+SAB only need it on the worker side).
 *
 * The wasm function table holds typed function references.  Each
 * pthread start_routine has the signature
 *   `(arg: i32) -> i32`
 * — `void *(*start_routine)(void *)` lowered to wasm32 with
 * pointers as i32.  The C frontend casts the function pointer to
 * (int) before passing it across the host-import boundary, so the
 * value the host receives is an indirect-call-table index.
 *
 * `WebAssembly.Table.get(idx)` returns a JS-callable function ref;
 * calling it invokes the wasm function.  When that function itself
 * calls async host imports (the typical case — pthread workers do
 * I/O), JSPI's `WebAssembly.promising` wraps the call so it returns
 * a Promise that resolves with the wasm function's i32 return value.
 *
 * `IndirectCallTable` wraps the table + a `promising` factory so
 * each backend can call a guest function without re-deriving the
 * JSPI plumbing every time.
 */

export interface IndirectCallTable {
  /**
   * Invoke the wasm function at table index `fnPtr` with a single
   * i32 argument, awaiting its async completion.  Returns the
   * function's i32 return value.  Throws if `fnPtr` is out of
   * bounds or the slot is null.
   */
  call(fnPtr: number, arg: number): Promise<number>;
}

/**
 * Build an IndirectCallTable backed by a real
 * `WebAssembly.Table` and the JSPI `promising` wrapper.
 *
 * The cooperative-serial backend uses this from inside
 * `host_thread_spawn` — when the guest calls pthread_create, this
 * code path runs the start_routine inline (re-entrant wasm call),
 * stores the return value, and resolves the spawn's host-side
 * Promise.  JSPI handles the suspend/resume so the original
 * pthread_create caller is also paused while the worker runs.
 */
export function makeIndirectCallTable(
  table: WebAssembly.Table,
  promising: (fn: unknown) => unknown,
): IndirectCallTable {
  return {
    async call(fnPtr: number, arg: number): Promise<number> {
      const fn = table.get(fnPtr);
      if (typeof fn !== 'function') {
        throw new Error(`indirect call: fnPtr ${fnPtr} is not a function`);
      }
      const wrapped = promising(fn) as (arg: number) => Promise<number>;
      return await wrapped(arg);
    },
  };
}

/**
 * Stub IndirectCallTable for backends that don't need to call back
 * into wasm directly (or for early-init paths before the wasm
 * instance is ready).
 */
export const NULL_INDIRECT_CALL_TABLE: IndirectCallTable = {
  call() {
    return Promise.reject(new Error('indirect call table not yet wired'));
  },
};
