#ifndef CODEPOD_COMPAT_STDIO_H
#define CODEPOD_COMPAT_STDIO_H

/* Pull in the real wasi-sdk stdio.h. */
#include_next <stdio.h>

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
