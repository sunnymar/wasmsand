#ifndef CODEPOD_COMPAT_H
#define CODEPOD_COMPAT_H

#include <stdint.h>
#include <stdio.h>

#define CODEPOD_GUEST_COMPAT_VERSION_MAJOR 1u
#define CODEPOD_GUEST_COMPAT_VERSION_MINOR 0u

extern uint32_t codepod_guest_compat_version;

/*
 * Narrow Phase A command-execution shim for codepod guests, part of the
 * codepod guest compatibility runtime (see
 * docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md).
 *
 * This is a codepod extension layer on top of wasi-libc, not a POSIX process
 * API. Only read-mode popen is supported, and codepod_pclose() returns the
 * captured raw exit code from the completed command.
 */
int codepod_system(const char *cmd);
FILE *codepod_popen(const char *cmd, const char *mode);
int codepod_pclose(FILE *stream);

#endif
