#ifndef CODEPOD_COMPAT_STDLIB_H
#define CODEPOD_COMPAT_STDLIB_H

/* Pull in the real wasi-sdk stdlib.h. */
#include_next <stdlib.h>

/* wasi-libc gates mktemp / mkstemp / mkostemp / mkdtemp behind
 * __wasilibc_unmodified_upstream and they are absent from the wasm32-wasip1
 * sysroot.  Provide real implementations here against the VFS:
 *
 *   - mktemp(3):     replace the trailing XXXXXX of the template with
 *                    crypto-quality random alphanumerics (via getentropy
 *                    → WASI random_get → host crypto.getRandomValues).
 *   - mkstemp(3):    mktemp + open(O_CREAT|O_EXCL); retry on EEXIST.
 *   - mkostemp(3):   mkstemp variant that takes extra open flags.
 *   - mkdtemp(3):    mktemp + mkdir; retry on EEXIST.
 *
 * All four are header-inlined so any C/C++ guest binary that links
 * libcodepod_guest_compat (or just sees this header on its include path)
 * gets working temp-file primitives without having to define them. */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* getentropy(3) is provided by wasi-libc and routes through WASI
 * random_get, which the codepod host services with crypto.getRandomValues
 * (see packages/orchestrator/src/wasi/wasi-host.ts:randomGet).  This is
 * the canonical crypto-quality entropy source for the sandbox. */
extern int getentropy(void *buffer, size_t length);

static inline char *codepod_mktemp_internal(char *tmpl) {
    static const char chars[] =
        "abcdefghijklmnopqrstuvwxyz"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "0123456789";
    if (!tmpl) {
        errno = EINVAL;
        return NULL;
    }
    size_t n = strlen(tmpl);
    if (n < 6 || strcmp(tmpl + n - 6, "XXXXXX") != 0) {
        errno = EINVAL;
        if (n) tmpl[0] = '\0';
        return tmpl;
    }
    unsigned char raw[6];
    if (getentropy(raw, sizeof raw) != 0) {
        /* getentropy can only fail if the host is broken; surface that
         * rather than fall back to a weak PRNG. */
        if (n) tmpl[0] = '\0';
        return tmpl;
    }
    for (int i = 0; i < 6; i++) {
        tmpl[n - 6 + i] = chars[raw[i] % 62];
    }
    return tmpl;
}

static inline char *mktemp(char *tmpl) {
    return codepod_mktemp_internal(tmpl);
}

static inline int mkstemp(char *tmpl) {
    for (int attempt = 0; attempt < 64; attempt++) {
        size_t n = strlen(tmpl);
        if (n < 6) { errno = EINVAL; return -1; }
        char saved[7];
        memcpy(saved, tmpl + n - 6, 7);
        if (codepod_mktemp_internal(tmpl) == NULL || tmpl[0] == '\0') return -1;
        int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL, 0600);
        if (fd >= 0) return fd;
        if (errno != EEXIST) return -1;
        memcpy(tmpl + n - 6, saved, 7);
    }
    errno = EEXIST;
    return -1;
}

static inline int mkostemp(char *tmpl, int flags) {
    /* O_CREAT|O_EXCL are mandatory; user `flags` add to them. */
    for (int attempt = 0; attempt < 64; attempt++) {
        size_t n = strlen(tmpl);
        if (n < 6) { errno = EINVAL; return -1; }
        char saved[7];
        memcpy(saved, tmpl + n - 6, 7);
        if (codepod_mktemp_internal(tmpl) == NULL || tmpl[0] == '\0') return -1;
        int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL | flags, 0600);
        if (fd >= 0) return fd;
        if (errno != EEXIST) return -1;
        memcpy(tmpl + n - 6, saved, 7);
    }
    errno = EEXIST;
    return -1;
}

static inline char *mkdtemp(char *tmpl) {
    for (int attempt = 0; attempt < 64; attempt++) {
        size_t n = strlen(tmpl);
        if (n < 6) { errno = EINVAL; return NULL; }
        char saved[7];
        memcpy(saved, tmpl + n - 6, 7);
        if (codepod_mktemp_internal(tmpl) == NULL || tmpl[0] == '\0') return NULL;
        if (mkdir(tmpl, 0700) == 0) return tmpl;
        if (errno != EEXIST) return NULL;
        memcpy(tmpl + n - 6, saved, 7);
    }
    errno = EEXIST;
    return NULL;
}

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_COMPAT_STDLIB_H */
