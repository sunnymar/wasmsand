#ifndef CODEPOD_BUSYBOX_COMPAT_UNISTD_H
#define CODEPOD_BUSYBOX_COMPAT_UNISTD_H

/* Pull in the real wasi-sdk unistd.h (and any intermediate compat shim). */
#include_next <unistd.h>

/* WASI / wasm32-wasip1 omits many POSIX functions that BusyBox references but
 * doesn't actually call on this platform (e.g., fork, exec, uid/gid helpers).
 * These declarations are guarded by __wasilibc_unmodified_upstream in the
 * WASI libc headers, so they are absent for wasm32-wasip1.  Add them here so
 * that BusyBox translation units compile.  All bodies are no-op stubs that
 * return a safe value (0 for "success" ops, ENOSYS for "not supported"). */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>
#include <sys/types.h>

/* pipe / dup */
static inline int pipe(int fd[2]) { (void)fd; errno = ENOSYS; return -1; }
static inline int dup(int oldfd) { (void)oldfd; errno = ENOSYS; return -1; }

/* chown family */
static inline int chown(const char *path, uid_t owner, gid_t group) {
    (void)path; (void)owner; (void)group; return 0; }
static inline int lchown(const char *path, uid_t owner, gid_t group) {
    (void)path; (void)owner; (void)group; return 0; }
static inline int fchown(int fd, uid_t owner, gid_t group) {
    (void)fd; (void)owner; (void)group; return 0; }

/* fchdir */
static inline int fchdir(int fd) { (void)fd; errno = ENOSYS; return -1; }

/* chroot */
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

/* setsid / ttyname_r */
static inline int setsid(void) { errno = ENOSYS; return -1; }
static inline int ttyname_r(int fd, char *buf, size_t buflen) {
    (void)fd; (void)buf; (void)buflen; errno = ENOSYS; return ENOSYS; }

/* Process tree introspection.  getpid()/getppid()/kill() are provided
 * by libcodepod_guest_compat (codepod_process.c) — they route through
 * codepod_host_getpid/getppid/kill imports to the real kernel.  We
 * declare them here so callers including only <unistd.h> see them, but
 * the bodies live in the compat archive.
 *
 * Process groups / sessions aren't modelled in the kernel; getpgrp()
 * etc. echo getpid() so the answers stay self-consistent. */
extern pid_t getppid(void);
static inline pid_t getpgrp(void) { return getpid(); }
static inline pid_t getpgid(pid_t pid) { (void)pid; return getpid(); }
static inline int setpgid(pid_t pid, pid_t pgid) {
    (void)pid; (void)pgid; return 0; }
static inline int setpgrp(void) { return 0; }
static inline pid_t getsid(pid_t pid) { (void)pid; return getpid(); }

/* kill() is declared in <signal.h> in POSIX; many BusyBox applets reach
 * for it via that include path.  Our compat header brings it in here so
 * callers including only <unistd.h> still see it; the body lives in
 * libcodepod_guest_compat (codepod_process.c). */
#include <signal.h>
extern int kill(pid_t pid, int sig);
static inline int killpg(pid_t pgrp, int sig) {
    /* Process groups aren't tracked separately; route to kill() and let
     * it answer ESRCH for unknown pgids. */
    return kill(-pgrp, sig);
}

/* uid/gid accessors – return root (0) as a safe default */
static inline uid_t getuid(void) { return 0; }
static inline uid_t geteuid(void) { return 0; }
static inline gid_t getgid(void) { return 0; }
static inline gid_t getegid(void) { return 0; }
static inline int setuid(uid_t uid) { (void)uid; return 0; }
static inline int seteuid(uid_t uid) { (void)uid; return 0; }
static inline int setgid(gid_t gid) { (void)gid; return 0; }
static inline int setegid(gid_t gid) { (void)gid; return 0; }

/* waitpid/wait: stubbed in sys/wait.h compat header. */

#endif /* !__wasilibc_unmodified_upstream */

#endif /* CODEPOD_BUSYBOX_COMPAT_UNISTD_H */
