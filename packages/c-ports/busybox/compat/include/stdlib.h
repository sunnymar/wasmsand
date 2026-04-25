#ifndef CODEPOD_BUSYBOX_COMPAT_STDLIB_H
#define CODEPOD_BUSYBOX_COMPAT_STDLIB_H

/* Pull in the real wasi-sdk stdlib.h */
#include_next <stdlib.h>

/* WASI omits mktemp/mkstemp/mkostemp/mkdtemp (guarded by
 * __wasilibc_unmodified_upstream).  Implement them here against the VFS:
 * mktemp generates a name; mkstemp/mkdtemp create the file or directory
 * with O_EXCL / mkdir, retrying on collision so the resulting path is
 * unique within the sandbox VFS. */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static inline char *codepod_mktemp_internal(char *tmpl) {
    static unsigned long codepod_mktemp_counter = 0;
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
    /* Mix in time + a per-process counter so successive calls differ
     * even when the host clock has coarse granularity. */
    unsigned long seed = (unsigned long)time(NULL) ^ ++codepod_mktemp_counter;
    seed ^= (seed << 13);
    seed ^= (seed >> 7);
    seed ^= (seed << 17);
    for (int i = 0; i < 6; i++) {
        tmpl[n - 6 + i] = chars[seed % 62];
        seed /= 62;
        seed = seed * 1103515245UL + 12345UL;
    }
    return tmpl;
}

/* mktemp(3): replace trailing XXXXXX with random alphanumerics.  POSIX
 * deprecates this for being TOCTOU-y, but BusyBox's mktemp(1) `-u` mode
 * and its in-tree libbb mkdtemp helper both call it. */
static inline char *mktemp(char *tmpl) {
    return codepod_mktemp_internal(tmpl);
}

/* mkstemp(3): mktemp + open(O_CREAT|O_EXCL).  Retries on EEXIST. */
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

/* mkdtemp(3): mktemp + mkdir.  Retries on EEXIST. */
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

#endif /* CODEPOD_BUSYBOX_COMPAT_STDLIB_H */
