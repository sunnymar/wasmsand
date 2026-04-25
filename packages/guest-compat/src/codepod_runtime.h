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

int codepod_json_call(const char *json, char **out, size_t *out_len);

#endif
