#ifndef CODEPOD_RUNTIME_H
#define CODEPOD_RUNTIME_H

#include <stdint.h>
#include <stddef.h>
#include <stdint.h>

__attribute__((import_module("codepod"), import_name("host_run_command")))
int codepod_host_run_command(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_dup2")))
int codepod_host_dup2(int src_fd, int dst_fd);

__attribute__((import_module("codepod"), import_name("host_yield")))
void codepod_host_yield(void);

__attribute__((import_module("codepod"), import_name("host_file_lock")))
int codepod_host_file_lock(int fd, int operation);

__attribute__((import_module("codepod"), import_name("host_chmod")))
int codepod_host_chmod(int path_ptr, int path_len, int mode);

__attribute__((import_module("codepod"), import_name("host_network_fetch")))
int codepod_host_network_fetch(int req_ptr, int req_len, int out_ptr, int out_cap);

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
 * packages/kernel/src/process/kernel.ts for the JSON shape. */
__attribute__((import_module("codepod"), import_name("host_spawn")))
int codepod_host_spawn(int req_ptr, int req_len);

/* host_fork duplicates the calling process when the module is built in
 * continuation mode.  Return convention follows fork(2): parent receives
 * the child PID, child receives 0.  Negative returns are -errno. */
__attribute__((import_module("codepod"), import_name("host_fork")))
int codepod_host_fork(void);

/* host_waitpid blocks until the named child exits and writes JSON
 * `{"exit_code":N}` to the output buffer.  Returns byte count or -1.
 * The kernel wraps this with WebAssembly.Suspending (JSPI) or
 * the asyncify bridge automatically — backend choice is host-wide
 * (wasi2-preempt > JSPI > asyncify), so the C caller just sees a
 * normal blocking call.  Used by waitpid(pid > 0). */
__attribute__((import_module("codepod"), import_name("host_waitpid")))
int codepod_host_waitpid(int pid, int out_ptr, int out_cap);

/* host_waitpid_nohang is the synchronous non-blocking variant.
 * It writes {"pid":N,"exit_code":M} and returns the byte count when
 * a child was reaped, -1 when no child has exited, and -2 for ECHILD. */
__attribute__((import_module("codepod"), import_name("host_waitpid_nohang")))
int codepod_host_waitpid_nohang(int pid, int out_ptr, int out_cap);

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

__attribute__((import_module("codepod"), import_name("host_socket_open")))
int codepod_host_socket_open(int domain, int type, int protocol);

__attribute__((import_module("codepod"), import_name("host_socket_connect")))
int codepod_host_socket_connect(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_bind")))
int codepod_host_socket_bind(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_listen")))
int codepod_host_socket_listen(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_accept")))
int codepod_host_socket_accept(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_send")))
int codepod_host_socket_send(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_recv")))
int codepod_host_socket_recv(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_addr")))
int codepod_host_socket_addr(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_option")))
int codepod_host_socket_option(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_socket_close")))
int codepod_host_socket_close(int req_ptr, int req_len);

/* host_resolve_hostname(name_ptr, name_len, out_ptr, out_cap) -> i32
 * Resolves a hostname to its first IPv4 address string (e.g. "93.184.216.34").
 * Returns the number of bytes written to out_ptr on success (positive).
 * Returns a negative EAI_* error code on failure (EAI_SYSTEM on browser or
 * when no resolver is configured). Async — must be wrapped with
 * WebAssembly.Suspending for JSPI (same pattern as host_network_fetch). */
__attribute__((import_module("codepod"), import_name("host_resolve_hostname")))
int codepod_host_resolve_hostname(int name_ptr, int name_len, int out_ptr, int out_cap);

/* host_get_local_addr(out_ptr, out_cap) -> i32
 * Writes the kernel-configured sandbox local IPv4 address string to out_ptr
 * (e.g. "10.0.2.15"). Returns bytes written. Sync. */
__attribute__((import_module("codepod"), import_name("host_get_local_addr")))
int codepod_host_get_local_addr(int out_ptr, int out_cap);

const char *codepod_netdb_host_for_addr(uint32_t addr_be);
uint32_t codepod_netdb_addr_for_host(const char *host);
int codepod_fd_get_status_flags(int fd);
void codepod_fd_set_status_flags(int fd, int flags);

int codepod_json_call(const char *json, char **out, size_t *out_len);

#endif
