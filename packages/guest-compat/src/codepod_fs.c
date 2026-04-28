/* Filesystem-ownership and process-priority shims that wasi-libc
 * doesn't ship.  These are real symbols (not static inline) so
 * gnulib's REPLACE_* probes detect them at link time and skip
 * compiling its own replacement copies — which would otherwise
 * collide with our compat headers' inline versions.
 *
 * Sandbox semantics: codepod doesn't model file ownership or
 * process priorities, so the calls accept-and-no-op (or return
 * sensible defaults) rather than fail.  Programs that actually
 * care about ownership round-tripping are out of scope.
 */

#include "codepod_markers.h"

#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <unistd.h>

CODEPOD_DECLARE_MARKER(chown);
CODEPOD_DECLARE_MARKER(lchown);
CODEPOD_DECLARE_MARKER(fchown);
CODEPOD_DECLARE_MARKER(fchdir);
CODEPOD_DECLARE_MARKER(chroot);
CODEPOD_DECLARE_MARKER(getpriority);
CODEPOD_DECLARE_MARKER(setpriority);

CODEPOD_DEFINE_MARKER(chown,       0x63686f77u) /* "chow" */
CODEPOD_DEFINE_MARKER(lchown,      0x6c63686fu) /* "lcho" */
CODEPOD_DEFINE_MARKER(fchown,      0x6663686fu) /* "fcho" */
CODEPOD_DEFINE_MARKER(fchdir,      0x66636864u) /* "fchd" */
CODEPOD_DEFINE_MARKER(chroot,      0x6368726fu) /* "chro" */
CODEPOD_DEFINE_MARKER(getpriority, 0x67707269u) /* "gpri" */
CODEPOD_DEFINE_MARKER(setpriority, 0x73707269u) /* "spri" */
/* getrusage is provided by libwasi-emulated-process-clocks; we used
 * to define it here too but that produces a duplicate-symbol link
 * error.  The wasi-emulated impl zero-fills the rusage struct,
 * which is what we want anyway. */

int chown(const char *path, uid_t owner, gid_t group) {
  CODEPOD_MARKER_CALL(chown);
  (void)path; (void)owner; (void)group;
  return 0;
}

int lchown(const char *path, uid_t owner, gid_t group) {
  CODEPOD_MARKER_CALL(lchown);
  (void)path; (void)owner; (void)group;
  return 0;
}

int fchown(int fd, uid_t owner, gid_t group) {
  CODEPOD_MARKER_CALL(fchown);
  (void)fd; (void)owner; (void)group;
  return 0;
}

int fchdir(int fd) {
  CODEPOD_MARKER_CALL(fchdir);
  (void)fd;
  errno = ENOSYS;
  return -1;
}

int chroot(const char *path) {
  CODEPOD_MARKER_CALL(chroot);
  (void)path;
  errno = ENOSYS;
  return -1;
}

int getpriority(int which, id_t who) {
  CODEPOD_MARKER_CALL(getpriority);
  (void)which; (void)who;
  return 0;
}

int setpriority(int which, id_t who, int prio) {
  CODEPOD_MARKER_CALL(setpriority);
  (void)which; (void)who; (void)prio;
  return 0;
}

/* getrusage: see comment above — libwasi-emulated-process-clocks
 * supplies it; defining ours would duplicate the symbol. */

/* ── Single-thread stdio locking ──
 * flockfile/funlockfile/ftrylockfile are POSIX file-locking
 * primitives for thread-safe stdio.  Codepod is single-threaded,
 * so they're no-ops.  wasi-libc doesn't ship them; gnulib will
 * compile its own getopt.c with `flockfile(stderr)` calls if it
 * doesn't see these symbols at link time.  Provide them as real
 * symbols so gnulib accepts the libc as already-locked. */
CODEPOD_DECLARE_MARKER(flockfile);
CODEPOD_DECLARE_MARKER(funlockfile);
CODEPOD_DECLARE_MARKER(ftrylockfile);
CODEPOD_DEFINE_MARKER(flockfile,    0x666c6f63u) /* "floc" */
CODEPOD_DEFINE_MARKER(funlockfile,  0x66756e6cu) /* "funl" */
CODEPOD_DEFINE_MARKER(ftrylockfile, 0x66747279u) /* "ftry" */

void flockfile(FILE *f)    { CODEPOD_MARKER_CALL(flockfile);    (void)f; }
void funlockfile(FILE *f)  { CODEPOD_MARKER_CALL(funlockfile);  (void)f; }
int  ftrylockfile(FILE *f) { CODEPOD_MARKER_CALL(ftrylockfile); (void)f; return 0; }

/* ── qsort_r — GNU-flavor (4-arg with arg-after-comparator) ──
 * wasi-libc has qsort but not qsort_r.  gnulib's lib/savedir.c uses
 * the GNU signature: qsort_r(base, nmemb, size, compar, arg).
 * Implement on top of qsort by stashing the user arg in a TLS-ish
 * static — fine here because codepod is single-threaded. */
CODEPOD_DECLARE_MARKER(qsort_r);
CODEPOD_DEFINE_MARKER(qsort_r, 0x71735f72u) /* "qs_r" */

static int (*qsort_r_compar)(const void *, const void *, void *) = NULL;
static void *qsort_r_arg = NULL;

static int qsort_r_thunk(const void *a, const void *b) {
  return qsort_r_compar(a, b, qsort_r_arg);
}

void qsort_r(void *base, size_t nmemb, size_t size,
             int (*compar)(const void *, const void *, void *),
             void *arg) {
  CODEPOD_MARKER_CALL(qsort_r);
  qsort_r_compar = compar;
  qsort_r_arg = arg;
  qsort(base, nmemb, size, qsort_r_thunk);
  qsort_r_compar = NULL;
  qsort_r_arg = NULL;
}

/* ── setresuid / setresgid — Linux extensions ──
 * Sandbox is single-user (uid=gid=1000); accept-and-ignore.  Required
 * for gnulib's lib/spawni.c which is dead code for us anyway, but
 * still needs to link. */
CODEPOD_DECLARE_MARKER(setresuid);
CODEPOD_DECLARE_MARKER(setresgid);
CODEPOD_DEFINE_MARKER(setresuid, 0x73727569u) /* "srui" */
CODEPOD_DEFINE_MARKER(setresgid, 0x73726769u) /* "srgi" */

int setresuid(uid_t r, uid_t e, uid_t s) {
  CODEPOD_MARKER_CALL(setresuid);
  (void)r; (void)e; (void)s;
  return 0;
}

int setresgid(gid_t r, gid_t e, gid_t s) {
  CODEPOD_MARKER_CALL(setresgid);
  (void)r; (void)e; (void)s;
  return 0;
}
