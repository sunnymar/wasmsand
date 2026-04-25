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

/* Process tree introspection.  wasi-libc has getpid(); the rest aren't
 * exposed.  Sandbox is single-process from the guest's perspective:
 * the parent is the codepod kernel ("init"), and process groups /
 * sessions don't apply.  Stub accordingly. */
static inline pid_t getppid(void) { return 1; }
static inline pid_t getpgrp(void) { return getpid(); }
static inline pid_t getpgid(pid_t pid) { (void)pid; return 1; }
static inline int setpgid(pid_t pid, pid_t pgid) {
    (void)pid; (void)pgid; return 0; }
static inline int setpgrp(void) { return 0; }
static inline pid_t getsid(pid_t pid) { (void)pid; return 1; }

/* Signal delivery.  kill() is declared by <signal.h> on Linux — many
 * BusyBox applets reach for it via that include path, but our shipped
 * <signal.h> compat doesn't surface it.  Declare it here too so callers
 * that include only <unistd.h> still see it.  Real semantics: the
 * codepod kernel owns process management; cross-process signals aren't
 * supported, so stub to ESRCH (no such process) for any non-self pid
 * and 0 for `kill(getpid(), 0)` (existence probe of self). */
#include <signal.h>
static inline int kill(pid_t pid, int sig) {
    (void)sig;
    if (pid == getpid() || pid == 0 || pid == -1) return 0;
    errno = ESRCH;
    return -1;
}
static inline int killpg(pid_t pgrp, int sig) {
    (void)pgrp; (void)sig; errno = ESRCH; return -1;
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
