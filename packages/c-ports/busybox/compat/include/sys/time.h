#ifndef CODEPOD_BUSYBOX_COMPAT_SYS_TIME_H
#define CODEPOD_BUSYBOX_COMPAT_SYS_TIME_H

/* Pull in the real wasi-sdk sys/time.h */
#include_next <sys/time.h>

/* WASI omits settimeofday (guarded by __wasilibc_unmodified_upstream).
 * Provide a no-op stub: WASI has no way to set the clock. */

#ifndef __wasilibc_unmodified_upstream

struct timezone;

static inline int settimeofday(const struct timeval *tv, const struct timezone *tz) {
    (void)tv; (void)tz; return 0; }

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_BUSYBOX_COMPAT_SYS_TIME_H */
