#ifndef CODEPOD_BUSYBOX_COMPAT_SIGNAL_H
#define CODEPOD_BUSYBOX_COMPAT_SIGNAL_H

/* Pull in the next signal.h (guest-compat shim, then wasi sysroot). */
#include_next <signal.h>

/* The guest-compat signal.h defines signal constants but not NSIG.
 * WASI's bits/signal.h defines _NSIG 65, but it is only reachable when
 * -D_WASI_EMULATED_SIGNAL is set AND the wasi sysroot signal.h is included.
 * Because the guest-compat signal.h does not chain via #include_next, the
 * wasi sysroot signal.h is never reached from this include path.
 * Define NSIG directly here so that BusyBox's u_signal_names.c compiles. */

#ifndef NSIG
#define NSIG 65
#endif

#endif /* CODEPOD_BUSYBOX_COMPAT_SIGNAL_H */
