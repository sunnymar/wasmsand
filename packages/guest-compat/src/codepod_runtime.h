#ifndef CODEPOD_RUNTIME_H
#define CODEPOD_RUNTIME_H

#include <stddef.h>

__attribute__((import_module("codepod"), import_name("host_run_command")))
int codepod_host_run_command(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_dup2")))
int codepod_host_dup2(int src_fd, int dst_fd);

/* Process identity / signalling — codepod's process kernel owns the
 * sandbox's PID space and tracks parent links and process state.  These
 * imports route guest libc calls (getpid/getppid/kill) to the kernel,
 * so they return real values instead of wasi-libc's stubs. */
__attribute__((import_module("codepod"), import_name("host_getpid")))
int codepod_host_getpid(void);

__attribute__((import_module("codepod"), import_name("host_getppid")))
int codepod_host_getppid(void);

/* host_kill returns 0 on success, -1 with kill(2)-style ESRCH (no such
 * process) on failure.  sig=0 is the existence probe (no signal sent). */
__attribute__((import_module("codepod"), import_name("host_kill")))
int codepod_host_kill(int pid, int sig);

/* host_pipe creates a pipe and writes JSON `{"read_fd":N,"write_fd":M}`
 * to the output buffer.  Returns the byte count written, or the
 * required size if out_cap was too small.  The 64-byte buffer in
 * pipe()/pipe2() is sized for that JSON shape. */
__attribute__((import_module("codepod"), import_name("host_pipe")))
int codepod_host_pipe(int out_ptr, int out_cap);

/* host_dup duplicates a fd in the caller's table and writes JSON
 * `{"fd":<new_fd>}` to the output buffer.  Returns byte count or -1.
 * dup(2) needs this so we can hand back a fresh kernel-managed fd. */
__attribute__((import_module("codepod"), import_name("host_dup")))
int codepod_host_dup(int fd, int out_ptr, int out_cap);

/* host_spawn synchronously spawns a child WASM process from a JSON
 * SpawnRequest.  Returns the new child's PID, or -1 on failure.
 * Used by posix_spawn / posix_spawnp.  See SpawnRequest in
 * packages/orchestrator/src/process/kernel.ts for the JSON shape. */
__attribute__((import_module("codepod"), import_name("host_spawn")))
int codepod_host_spawn(int req_ptr, int req_len);

/* host_waitpid blocks until the named child exits and writes JSON
 * `{"exit_code":N}` to the output buffer.  Returns byte count or -1.
 * The orchestrator wraps this with WebAssembly.Suspending (JSPI) or
 * the asyncify bridge automatically — backend choice is host-wide
 * (wasi2-preempt > JSPI > asyncify), so the C caller just sees a
 * normal blocking call.  Used by waitpid(pid > 0). */
__attribute__((import_module("codepod"), import_name("host_waitpid")))
int codepod_host_waitpid(int pid, int out_ptr, int out_cap);

/* host_waitpid_nohang is the synchronous non-blocking variant —
 * returns the child's exit code if the process has already exited,
 * or -1 if it's still running.  Used internally by guest-side
 * helpers; not a real waitpid(WNOHANG) replacement because it
 * doesn't unblock signal-style notifications. */
__attribute__((import_module("codepod"), import_name("host_waitpid_nohang")))
int codepod_host_waitpid_nohang(int pid);

/* ── Threading host imports ────────────────────────────────────
 *
 * Backend-routed pthread surface — see
 * docs/superpowers/specs/2026-04-27-wasi-threads-design.md.  The
 * guest binary always imports these; the orchestrator-side backend
 * implementation varies (cooperative-serial / wasi-threads /
 * Worker+SAB / WASI Preview 2).  Same .wasm runs on every backend.
 *
 * host_thread_spawn(fn_ptr, arg) — schedule start_routine(arg) and
 * return a thread id.  Cooperative-serial backends inline-invoke
 * via __indirect_function_table.get(fn_ptr); real-thread backends
 * dispatch to a wasi-thread or Worker.  Returns -1 on failure.
 *
 * host_thread_join(tid) returns the start_routine return value
 * (cast to int — 32-bit on wasm32).  Suspends via JSPI/Asyncify
 * until the thread completes.  Returns -1 if tid is invalid.
 *
 * host_mutex_*, host_cond_* operate on the opaque payload of the
 * pthread_mutex_t / pthread_cond_t struct.  The C frontend passes
 * a pointer to the struct's first opaque slot; the backend
 * interprets it however it likes (atomic-CAS state, futex word,
 * etc.).  Cooperative-serial backends ignore the pointer and
 * always succeed. */

__attribute__((import_module("codepod"), import_name("host_thread_spawn")))
int codepod_host_thread_spawn(int fn_ptr, int arg);

__attribute__((import_module("codepod"), import_name("host_thread_join")))
int codepod_host_thread_join(int tid);

__attribute__((import_module("codepod"), import_name("host_thread_detach")))
int codepod_host_thread_detach(int tid);

__attribute__((import_module("codepod"), import_name("host_thread_self")))
int codepod_host_thread_self(void);

__attribute__((import_module("codepod"), import_name("host_thread_yield")))
int codepod_host_thread_yield(void);

__attribute__((import_module("codepod"), import_name("host_mutex_lock")))
int codepod_host_mutex_lock(int mutex_ptr);

__attribute__((import_module("codepod"), import_name("host_mutex_unlock")))
int codepod_host_mutex_unlock(int mutex_ptr);

__attribute__((import_module("codepod"), import_name("host_mutex_trylock")))
int codepod_host_mutex_trylock(int mutex_ptr);

__attribute__((import_module("codepod"), import_name("host_cond_wait")))
int codepod_host_cond_wait(int cond_ptr, int mutex_ptr);

__attribute__((import_module("codepod"), import_name("host_cond_signal")))
int codepod_host_cond_signal(int cond_ptr);

__attribute__((import_module("codepod"), import_name("host_cond_broadcast")))
int codepod_host_cond_broadcast(int cond_ptr);

int codepod_json_call(const char *json, char **out, size_t *out_len);

#endif
