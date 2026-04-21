#ifndef CODEPOD_COMPAT_H
#define CODEPOD_COMPAT_H

#include <stdio.h>

/*
 * Narrow phase-1 command-execution shim for codepod guests.
 *
 * This is a codepod extension layer on top of wasi-libc, not a POSIX process
 * API. Only read-mode popen is supported, and codepod_pclose() returns the
 * captured raw exit code from the completed command.
 */
int codepod_system(const char *cmd);
FILE *codepod_popen(const char *cmd, const char *mode);
int codepod_pclose(FILE *stream);

#endif
