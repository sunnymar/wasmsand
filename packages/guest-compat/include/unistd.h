#ifndef CODEPOD_COMPAT_UNISTD_H
#define CODEPOD_COMPAT_UNISTD_H

/* Pull in the real wasi-sdk unistd.h.  wasi-libc marks getpid() as
 * deprecated to nudge users toward -D_WASI_EMULATED_GETPID, but codepod
 * provides a real getpid() via libcodepod_guest_compat (codepod_process.c
 * → codepod_host_getpid → kernel.allocPid), so the deprecation warning
 * is misleading.  Suppress it across everything that includes this
 * header so guest TUs aren't drowned in noise. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#include_next <unistd.h>
#pragma clang diagnostic pop

int dup2(int oldfd, int newfd);
int getgroups(int size, gid_t list[]);

/* wasi-libc gates many POSIX entries behind __wasilibc_unmodified_upstream
 * so they are absent on wasm32-wasip1.  The block below restores enough
 * surface for typical guest C/C++ programs to compile and link.  Real
 * impls (getpid/getppid/kill) come from libcodepod_guest_compat;
 * everything else is honest no-op-or-ENOSYS so callers can detect the
 * gap and degrade gracefully. */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>
#include <sys/types.h>

/* pipe / dup */
static inline int pipe(int fd[2]) { (void)fd; errno = ENOSYS; return -1; }
static inline int dup(int oldfd) { (void)oldfd; errno = ENOSYS; return -1; }

/* chown family — sandbox doesn't model file ownership; accept silently. */
static inline int chown(const char *path, uid_t owner, gid_t group) {
    (void)path; (void)owner; (void)group; return 0; }
static inline int lchown(const char *path, uid_t owner, gid_t group) {
    (void)path; (void)owner; (void)group; return 0; }
static inline int fchown(int fd, uid_t owner, gid_t group) {
    (void)fd; (void)owner; (void)group; return 0; }

static inline int fchdir(int fd) { (void)fd; errno = ENOSYS; return -1; }
static inline int chroot(const char *path) { (void)path; errno = ENOSYS; return -1; }

/* fork / exec / vfork.  POSIX exec replaces the current process image,
 * which wasm doesn't expose (the wasi `process-replace` proposal isn't
 * stable yet), so the v-form base implementations stub to ENOSYS — that
 * lets callers detect "exec unsupported" cleanly instead of silently
 * spawning a child and pretending it was a replace.  The variadic l-form
 * helpers below delegate to the v-forms, so they fail the same way. */
static inline int fork(void) { errno = ENOSYS; return -1; }
static inline int vfork(void) { errno = ENOSYS; return -1; }
static inline int execv(const char *path, char *const argv[]) {
    (void)path; (void)argv; errno = ENOSYS; return -1; }
static inline int execvp(const char *file, char *const argv[]) {
    (void)file; (void)argv; errno = ENOSYS; return -1; }
static inline int execve(const char *path, char *const argv[], char *const envp[]) {
    (void)path; (void)argv; (void)envp; errno = ENOSYS; return -1; }

#include <stdarg.h>
#define CODEPOD_EXEC_MAX_ARGS 64

static inline int execl(const char *path, const char *arg0, ...) {
    const char *argv_local[CODEPOD_EXEC_MAX_ARGS + 1];
    int n = 0;
    argv_local[n++] = arg0;
    va_list ap;
    va_start(ap, arg0);
    const char *a;
    while (n <= CODEPOD_EXEC_MAX_ARGS && (a = va_arg(ap, const char *)) != NULL) {
        argv_local[n++] = a;
    }
    va_end(ap);
    argv_local[n] = NULL;
    return execv(path, (char *const *)argv_local);
}

static inline int execlp(const char *file, const char *arg0, ...) {
    const char *argv_local[CODEPOD_EXEC_MAX_ARGS + 1];
    int n = 0;
    argv_local[n++] = arg0;
    va_list ap;
    va_start(ap, arg0);
    const char *a;
    while (n <= CODEPOD_EXEC_MAX_ARGS && (a = va_arg(ap, const char *)) != NULL) {
        argv_local[n++] = a;
    }
    va_end(ap);
    argv_local[n] = NULL;
    return execvp(file, (char *const *)argv_local);
}

static inline int execle(const char *path, const char *arg0, ...) {
    /* execle: arg0, ..., NULL, envp.  Walk the va_list, build argv up to
     * the NULL, then take the next va_arg as envp. */
    const char *argv_local[CODEPOD_EXEC_MAX_ARGS + 1];
    int n = 0;
    argv_local[n++] = arg0;
    va_list ap;
    va_start(ap, arg0);
    const char *a;
    while (n <= CODEPOD_EXEC_MAX_ARGS && (a = va_arg(ap, const char *)) != NULL) {
        argv_local[n++] = a;
    }
    argv_local[n] = NULL;
    char *const *envp = va_arg(ap, char *const *);
    va_end(ap);
    return execve(path, (char *const *)argv_local, envp);
}

/* Process tree introspection — getpid()/getppid() are provided by
 * libcodepod_guest_compat (codepod_process.c) and route through real
 * kernel state.  Re-declare here without the wasi-libc deprecation
 * attribute so static-inline callers below don't emit warnings. */
extern pid_t getpid(void);
extern pid_t getppid(void);

/* setsid: POSIX returns the new session id (== caller pid) on success.
 * The sandbox doesn't model sessions distinctly from processes, so we
 * report "you are now session leader" by returning getpid().  This is
 * consistent with getsid()/getpgrp() below — all answer with the
 * caller's pid, so session/group plumbing stays self-consistent. */
static inline int setsid(void) { return (int)getpid(); }

/* ttyname_r: POSIX requires ENOTTY when fd isn't a terminal.  We
 * defer to isatty() (which wasi-libc implements via fdstat) and
 * synthesize a name when the fd IS a tty.  The sandbox doesn't have
 * a real tty device path, but "/dev/tty" is the conventional answer
 * and matches what stdio expects. */
static inline int ttyname_r(int fd, char *buf, size_t buflen) {
    if (!buf || buflen == 0) return EINVAL;
    if (!isatty(fd)) return ENOTTY;
    static const char tty[] = "/dev/tty";
    if (buflen < sizeof(tty)) return ERANGE;
    for (size_t i = 0; i < sizeof(tty); i++) buf[i] = tty[i];
    return 0;
}

/* Process groups / sessions aren't modelled in the kernel; getpgrp()
 * etc. echo getpid() so the answers stay self-consistent. */
static inline pid_t getpgrp(void) { return getpid(); }
static inline pid_t getpgid(pid_t pid) { (void)pid; return getpid(); }
static inline int setpgid(pid_t pid, pid_t pgid) {
    (void)pid; (void)pgid; return 0; }
static inline int setpgrp(void) { return 0; }
static inline pid_t getsid(pid_t pid) { (void)pid; return getpid(); }

/* sethostname() — wasi-libc has gethostname but not the setter.  Stub
 * to ENOSYS so callers see the failure; the sandbox hostname is
 * effectively read-only from the guest's perspective. */
static inline int sethostname(const char *name, size_t len) {
    (void)name; (void)len; errno = ENOSYS; return -1;
}

/* Some C code out there guards `#include <sys/sysinfo.h>` behind
 * `#ifdef __linux__` (or relies on the glibc convenience of getting
 * it transitively through unistd.h) and then uses `struct sysinfo`
 * unconditionally — fine on Linux, broken on every other platform.
 * Pulling sysinfo.h here makes the declarations visible regardless
 * of whether the consumer remembered the include.  The actual impl
 * lives in libcodepod_guest_compat (codepod_sysinfo.c). */
#include <sys/sysinfo.h>

/* kill() is declared in <signal.h> in POSIX, but many programs reach
 * for it via <unistd.h> include paths.  Bring it in here so callers
 * see the prototype either way; the body lives in
 * libcodepod_guest_compat (codepod_process.c). */
#include <signal.h>
extern int kill(pid_t pid, int sig);
static inline int killpg(pid_t pgrp, int sig) {
    /* Process groups aren't tracked separately; route to kill() and let
     * it answer ESRCH for unknown pgids. */
    return kill(-pgrp, sig);
}

/* uid/gid accessors — sandbox is single-user.  Report a regular,
 * non-privileged user (1000) rather than root (0): many tools take
 * different code paths under euid==0 (skip permission checks, refuse
 * to run, attempt privileged ops), and we are NOT a privileged
 * environment.  The value matches the codepod `id` applet output
 * (uid=1000(user) gid=1000(user)) so guest and sandbox agree.
 *
 * set*uid/set*gid silently succeed when the caller asks for the
 * current id (POSIX-conformant; setuid(geteuid()) is a no-op) and
 * fail with EPERM otherwise — we cannot actually change identity. */
#define CODEPOD_DEFAULT_UID ((uid_t)1000)
#define CODEPOD_DEFAULT_GID ((gid_t)1000)

static inline uid_t getuid(void) { return CODEPOD_DEFAULT_UID; }
static inline uid_t geteuid(void) { return CODEPOD_DEFAULT_UID; }
static inline gid_t getgid(void) { return CODEPOD_DEFAULT_GID; }
static inline gid_t getegid(void) { return CODEPOD_DEFAULT_GID; }
static inline int setuid(uid_t uid) {
    if (uid == CODEPOD_DEFAULT_UID) return 0;
    errno = EPERM; return -1;
}
static inline int seteuid(uid_t uid) {
    if (uid == CODEPOD_DEFAULT_UID) return 0;
    errno = EPERM; return -1;
}
static inline int setgid(gid_t gid) {
    if (gid == CODEPOD_DEFAULT_GID) return 0;
    errno = EPERM; return -1;
}
static inline int setegid(gid_t gid) {
    if (gid == CODEPOD_DEFAULT_GID) return 0;
    errno = EPERM; return -1;
}

/* waitpid/wait: stubbed in sys/wait.h. */

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_COMPAT_UNISTD_H */
