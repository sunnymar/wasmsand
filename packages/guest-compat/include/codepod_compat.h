#ifndef CODEPOD_COMPAT_H
#define CODEPOD_COMPAT_H

#include <stdint.h>
#include <stdio.h>

/* Guest-compat ABI version — the major/minor of the host↔guest
 * protocol (host imports, signal numbers, etc.).  Separate from the
 * codepod product version below: a host running guest-compat ABI 2.x
 * still ships codepod 0.1.x. */
#define CODEPOD_GUEST_COMPAT_VERSION_MAJOR 1u
#define CODEPOD_GUEST_COMPAT_VERSION_MINOR 0u

/* Codepod product version — surfaced through uname utsname.release
 * / .version, /proc/version, and banner output.  Sourced from the
 * top-level VERSION file by scripts/sync-version.sh — DO NOT edit
 * by hand; bump VERSION and re-run the script.  String form is what
 * the C side uses; the numeric form below covers any callers that
 * need to compare versions programmatically. */
#define CODEPOD_VERSION_STR    "0.1.0"
#define CODEPOD_VERSION_MAJOR  0u
#define CODEPOD_VERSION_MINOR  1u
#define CODEPOD_VERSION_PATCH  0u

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
