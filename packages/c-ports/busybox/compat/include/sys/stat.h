#ifndef CODEPOD_BUSYBOX_COMPAT_SYS_STAT_H
#define CODEPOD_BUSYBOX_COMPAT_SYS_STAT_H

/* Pull in the real wasi-sdk sys/stat.h */
#include_next <sys/stat.h>

/* WASI omits mknod and umask (guarded by __wasilibc_unmodified_upstream).
 * Provide no-op stubs so that BusyBox's libarchive and libbb compile.
 * At runtime: mknod returns -1 (unsupported), umask is a no-op. */

#ifndef __wasilibc_unmodified_upstream

#include <sys/types.h>

static inline int mknod(const char *path, mode_t mode, dev_t dev) {
    (void)path; (void)mode; (void)dev; return -1; }
static inline mode_t umask(mode_t mask) { (void)mask; return 0022; }

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_BUSYBOX_COMPAT_SYS_STAT_H */
