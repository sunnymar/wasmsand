#ifndef CODEPOD_COMPAT_STDIO_H
#define CODEPOD_COMPAT_STDIO_H

/* Pull in the real wasi-sdk stdio.h. */
#include_next <stdio.h>

/* flockfile / funlockfile / ftrylockfile — POSIX thread-safe stdio
 * locking.  wasi-libc gates these behind `_REENTRANT` (single-thread
 * sandbox builds don't define it), but autoconf-generated code
 * routinely calls them and expects the declarations.  Codepod is
 * single-threaded; real impls are no-ops in libcodepod_guest_compat
 * (codepod_fs.c).  Expose unconditionally so configure probes find
 * the declarations. */
void flockfile(FILE *f);
void funlockfile(FILE *f);
int  ftrylockfile(FILE *f);

/* popen(3) / pclose(3) — POSIX, not in wasi-libc.
 *
 * Provided by libcodepod_guest_compat (codepod_process.c → wraps
 * codepod_popen / codepod_pclose, which route through host_run_command
 * to actually run the shell command).  The codepod runtime owns the
 * subprocess, so popen returns a FILE* you can read or write end-to-end
 * and pclose collects the exit status — no fork/exec involved.
 *
 * Declared here so any guest C program that includes <stdio.h> and links
 * libcodepod_guest_compat sees the prototypes — there's nothing
 * BusyBox-specific about this; it's a plain POSIX surface gap. */
FILE *popen(const char *command, const char *mode);
int pclose(FILE *stream);

#endif /* CODEPOD_COMPAT_STDIO_H */
