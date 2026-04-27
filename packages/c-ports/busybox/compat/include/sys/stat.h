#ifndef CODEPOD_BUSYBOX_COMPAT_SYS_STAT_H
#define CODEPOD_BUSYBOX_COMPAT_SYS_STAT_H

/* Pull in the real wasi-sdk sys/stat.h.  Note: when the codepod
 * guest-compat headers are on the include path too, `#include_next`
 * chains to the guest-compat sys/stat.h shim — which declares
 * `umask` as a real symbol backed by libcodepod_guest_compat.a
 * (codepod_process.c).  We used to define a static-inline umask
 * here as well; that now collides. */
#include_next <sys/stat.h>

#ifndef __wasilibc_unmodified_upstream

#include <sys/types.h>

/* mknod is still a BusyBox-port-specific stub: codepod has no
 * device-node concept, but libarchive and libbb reference mknod
 * unconditionally.  guest-compat doesn't ship mknod (no other port
 * needs it), so the no-op lives here. */
static inline int mknod(const char *path, mode_t mode, dev_t dev) {
    (void)path; (void)mode; (void)dev; return -1; }

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_BUSYBOX_COMPAT_SYS_STAT_H */
