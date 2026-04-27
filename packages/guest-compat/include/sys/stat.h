#ifndef CODEPOD_COMPAT_SYS_STAT_H
#define CODEPOD_COMPAT_SYS_STAT_H

/* wasi-libc gates `umask` behind __wasilibc_unmodified_upstream, so
 * it's invisible on wasm32-wasip1 by default.  Codepod ships a real
 * `umask` impl in libcodepod_guest_compat.a (codepod_process.c) that
 * tracks a process-wide mask (default 022, POSIX).  Pull in wasi-sdk's
 * <sys/stat.h> for the bulk of the surface, then declare umask
 * unconditionally so guest C code that reads/writes the mask compiles. */

#include_next <sys/stat.h>

#ifndef __wasilibc_unmodified_upstream
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

mode_t umask(mode_t mask);

#ifdef __cplusplus
}
#endif

#endif /* !__wasilibc_unmodified_upstream */

#endif
