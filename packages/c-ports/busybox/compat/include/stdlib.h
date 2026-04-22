#ifndef CODEPOD_BUSYBOX_COMPAT_STDLIB_H
#define CODEPOD_BUSYBOX_COMPAT_STDLIB_H

/* Pull in the real wasi-sdk stdlib.h */
#include_next <stdlib.h>

/* WASI omits mkstemp/mkostemp/mkdtemp (guarded by __wasilibc_unmodified_upstream).
 * Provide stubs so BusyBox libbb compiles. */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>

static inline int mkstemp(char *tmpl) { (void)tmpl; errno = ENOSYS; return -1; }
static inline int mkostemp(char *tmpl, int flags) {
    (void)tmpl; (void)flags; errno = ENOSYS; return -1; }
/* mkdtemp is NOT stubbed here: BusyBox provides its own implementation in
 * libbb/platform.c (guarded by #ifndef HAVE_MKDTEMP). */

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_BUSYBOX_COMPAT_STDLIB_H */
