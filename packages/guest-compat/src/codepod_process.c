/* Process identity + signalling — wired through to the codepod kernel.
 *
 * wasi-libc ships getpid() returning a stub constant and has no
 * getppid()/kill().  When this object is whole-archive'd into a guest
 * binary, our symbols win the link order vs. wasi-libc's, so all guest
 * code (BusyBox, Rust crates linking compat, etc.) sees real PIDs.
 *
 * §Override And Link Precedence — see ../README and the CODEPOD_MARKERS
 * §Verifying Precedence checks for confirmation that these symbols
 * cover their respective Tier 1 entries.
 */

#include <errno.h>
#include <signal.h>
#include <sys/types.h>
#include <unistd.h>

#include "codepod_markers.h"
#include "codepod_runtime.h"

CODEPOD_DECLARE_MARKER(getpid);
CODEPOD_DECLARE_MARKER(getppid);
CODEPOD_DECLARE_MARKER(kill);

CODEPOD_DEFINE_MARKER(getpid,  0x67706964u) /* gpid */
CODEPOD_DEFINE_MARKER(getppid, 0x67707064u) /* gppd */
CODEPOD_DEFINE_MARKER(kill,    0x6b696c6cu) /* kill */

pid_t getpid(void) {
    CODEPOD_MARKER_CALL(getpid);
    return (pid_t)codepod_host_getpid();
}

pid_t getppid(void) {
    CODEPOD_MARKER_CALL(getppid);
    return (pid_t)codepod_host_getppid();
}

int kill(pid_t pid, int sig) {
    CODEPOD_MARKER_CALL(kill);
    int rc = codepod_host_kill((int)pid, sig);
    if (rc < 0) {
        errno = ESRCH;
        return -1;
    }
    return 0;
}

/* popen / pclose libc names — wasi-libc doesn't ship them; codepod
 * provides codepod_popen / codepod_pclose against host_run_command.
 * Expose the standard POSIX names by aliasing to those impls so any
 * guest C program that links libcodepod_guest_compat gets the real
 * popen/pclose, regardless of how it spells its build (BusyBox, awk
 * variants, hand-rolled C, Rust crates pulling in libc, etc.). */
#include <stdio.h>

extern FILE *codepod_popen(const char *cmd, const char *mode);
extern int codepod_pclose(FILE *stream);

FILE *popen(const char *cmd, const char *mode) {
    return codepod_popen(cmd, mode);
}

int pclose(FILE *stream) {
    return codepod_pclose(stream);
}

/* wait(2) / waitpid(2) — POSIX wait surface routed through the
 * codepod kernel's host_waitpid.  host_waitpid is async on the
 * orchestrator side; the host wraps it with JSPI Suspending (or
 * the asyncify bridge as fallback), so from the C caller's
 * perspective it's a normal blocking call regardless of the
 * underlying scheduler — wasi-2-preempt, JSPI, or asyncify.
 *
 * The host_waitpid response is JSON `{"exit_code":N}`; we do an
 * inline parse to avoid pulling in the codepod_command JSON helpers
 * for what should be a hot path on tools that posix_spawn children.
 *
 * waitpid(pid > 0): blocks via host_waitpid until that specific
 *   child exits.  Honors WNOHANG by switching to host_waitpid_nohang.
 * waitpid(-1) / wait(): the host doesn't expose a "wait for any
 *   child" primitive yet, and the guest doesn't track its own spawn
 *   list.  We return ECHILD — POSIX-correct when there are no
 *   children to wait for.  Adding a host_wait_any import is the
 *   natural follow-up; track via codepod_runtime.h. */

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/wait.h>

CODEPOD_DECLARE_MARKER(wait);
CODEPOD_DECLARE_MARKER(waitpid);
CODEPOD_DEFINE_MARKER(wait,    0x77616974u) /* "wait" */
CODEPOD_DEFINE_MARKER(waitpid, 0x77706964u) /* "wpid" */

/* Pull `"exit_code":N` out of the JSON response. */
static int waitpid_parse_exit(const char *json, size_t json_len, int *out) {
    static const char needle[] = "\"exit_code\":";
    size_t nlen = sizeof(needle) - 1;
    for (size_t i = 0; i + nlen <= json_len; ++i) {
        if (memcmp(json + i, needle, nlen) != 0) continue;
        const char *p = json + i + nlen;
        const char *end = json + json_len;
        int sign = 1;
        if (p < end && *p == '-') { sign = -1; ++p; }
        int val = 0;
        int saw = 0;
        while (p < end && *p >= '0' && *p <= '9') {
            val = val * 10 + (*p - '0');
            saw = 1;
            ++p;
        }
        if (!saw) return -1;
        *out = sign * val;
        return 0;
    }
    return -1;
}

/* Pack a kernel exit code into the POSIX wait status encoding so
 * WIFEXITED / WEXITSTATUS / WTERMSIG round-trip cleanly:
 *   - low byte = signal (0 if exited normally)
 *   - bits 8-15 = exit code
 * Negative codes from the kernel (host_waitpid returns -1 if the
 * process couldn't be waited on) are reported as ECHILD by the
 * caller; we don't try to encode them in the status. */
static int encode_wait_status(int kernel_exit) {
    if (kernel_exit < 0) return 0;
    if (kernel_exit == 124) return 9; /* SIGKILL-style cancel → WIFSIGNALED */
    return (kernel_exit & 0xff) << 8;
}

pid_t waitpid(pid_t pid, int *wstatus, int options) {
    CODEPOD_MARKER_CALL(waitpid);
    if (pid <= 0) {
        /* Wait-any (-1) and process-group (0) are not yet routed.
         * See header note above. */
        errno = ECHILD;
        return (pid_t)-1;
    }

    int exit_code;
    if (options & WNOHANG) {
        exit_code = codepod_host_waitpid_nohang((int)pid);
        if (exit_code < 0) {
            /* Still running: WNOHANG returns 0 with status untouched. */
            return 0;
        }
    } else {
        char buf[64];
        int n = codepod_host_waitpid((int)pid, (int)(intptr_t)buf, (int)sizeof(buf));
        if (n <= 0 || (size_t)n > sizeof(buf)) {
            errno = ECHILD;
            return (pid_t)-1;
        }
        if (waitpid_parse_exit(buf, (size_t)n, &exit_code) != 0) {
            errno = ECHILD;
            return (pid_t)-1;
        }
    }

    if (wstatus) *wstatus = encode_wait_status(exit_code);
    return pid;
}

pid_t wait(int *wstatus) {
    CODEPOD_MARKER_CALL(wait);
    /* wait() is waitpid(-1, ..., 0) — wait-any.  Not yet supported
     * because the host has no "wait for any child" primitive and
     * the guest doesn't track its own spawn list.  Tools that need
     * to reap a specific posix_spawn'd child should use waitpid(pid)
     * directly. */
    (void)wstatus;
    errno = ECHILD;
    return (pid_t)-1;
}

/* ── Process group / session / file mode mask ──
 *
 * wasi-libc declares these in <unistd.h> / <sys/stat.h> only when
 * `__wasilibc_unmodified_upstream` is set, so on wasm32-wasip1 they
 * compile out entirely.  Codepod is a single-process-group, single-
 * session sandbox; the natural answers are:
 *   - umask: track a process-wide mask, default 022 (POSIX).  We
 *     don't actually apply it in the VFS today, but tools that
 *     read/write the mask roundtrip cleanly so they get the
 *     defensive behaviour they asked for.
 *   - getpgrp/getpgid/setpgid/setsid/getsid: report PID 1 as
 *     everyone's pgroup/session, accept setpgid silently.  Mirrors
 *     a single-init-style system.
 *   - tcgetpgrp/tcsetpgrp: terminal-control APIs; codepod has no
 *     controlling terminal, so tcgetpgrp returns -1/ENOTTY and
 *     tcsetpgrp accepts (ignored).
 *
 * Per the policy: we provide as much surface as possible from real
 * libc symbols so autotools-built ports' link probes find them.
 */

#include <sys/stat.h>

CODEPOD_DECLARE_MARKER(umask);
CODEPOD_DECLARE_MARKER(getpgrp);
CODEPOD_DECLARE_MARKER(getpgid);
CODEPOD_DECLARE_MARKER(setpgid);
CODEPOD_DECLARE_MARKER(setpgrp);
CODEPOD_DECLARE_MARKER(getsid);
CODEPOD_DECLARE_MARKER(setsid);
CODEPOD_DECLARE_MARKER(tcgetpgrp);
CODEPOD_DECLARE_MARKER(tcsetpgrp);

CODEPOD_DEFINE_MARKER(umask,     0x756d736bu) /* "umsk" */
CODEPOD_DEFINE_MARKER(getpgrp,   0x67706770u) /* "gpgp" */
CODEPOD_DEFINE_MARKER(getpgid,   0x67706764u) /* "gpgd" */
CODEPOD_DEFINE_MARKER(setpgid,   0x73706764u) /* "spgd" */
CODEPOD_DEFINE_MARKER(setpgrp,   0x73706770u) /* "spgp" */
CODEPOD_DEFINE_MARKER(getsid,    0x67736964u) /* "gsid" */
CODEPOD_DEFINE_MARKER(setsid,    0x73736964u) /* "ssid" */
CODEPOD_DEFINE_MARKER(tcgetpgrp, 0x74636770u) /* "tcgp" */
CODEPOD_DEFINE_MARKER(tcsetpgrp, 0x74637370u) /* "tcsp" */

static mode_t codepod_umask_state = 022;

mode_t umask(mode_t mask) {
    CODEPOD_MARKER_CALL(umask);
    mode_t prev = codepod_umask_state;
    codepod_umask_state = mask & 0777;
    return prev;
}

pid_t getpgrp(void) {
    CODEPOD_MARKER_CALL(getpgrp);
    return 1;
}

pid_t getpgid(pid_t pid) {
    CODEPOD_MARKER_CALL(getpgid);
    (void)pid;
    return 1;
}

int setpgid(pid_t pid, pid_t pgid) {
    CODEPOD_MARKER_CALL(setpgid);
    (void)pid; (void)pgid;
    /* POSIX allows setpgid to succeed silently when joining the
     * existing pgroup; codepod has only one. */
    return 0;
}

pid_t setpgrp(void) {
    CODEPOD_MARKER_CALL(setpgrp);
    return 1;
}

pid_t getsid(pid_t pid) {
    CODEPOD_MARKER_CALL(getsid);
    (void)pid;
    return 1;
}

pid_t setsid(void) {
    CODEPOD_MARKER_CALL(setsid);
    /* No new session to create — return our existing session id. */
    return 1;
}

pid_t tcgetpgrp(int fd) {
    CODEPOD_MARKER_CALL(tcgetpgrp);
    (void)fd;
    /* No controlling terminal in the sandbox. */
    errno = ENOTTY;
    return (pid_t)-1;
}

int tcsetpgrp(int fd, pid_t pgrp) {
    CODEPOD_MARKER_CALL(tcsetpgrp);
    (void)fd; (void)pgrp;
    /* No controlling terminal — accept silently. */
    return 0;
}

/* fork(2) / vfork(2) — POSIX process duplication primitives.
 * wasm32-wasip1 has no fork(); the closest we offer is host_spawn
 * via posix_spawn family.  Programs that explicitly call fork
 * should use posix_spawn instead.  Both return -1/ENOSYS. */
CODEPOD_DECLARE_MARKER(fork);
CODEPOD_DECLARE_MARKER(vfork);
CODEPOD_DEFINE_MARKER(fork,  0x666f726bu) /* "fork" */
CODEPOD_DEFINE_MARKER(vfork, 0x76666f72u) /* "vfor" */

pid_t fork(void) {
    CODEPOD_MARKER_CALL(fork);
    errno = ENOSYS;
    return (pid_t)-1;
}

pid_t vfork(void) {
    CODEPOD_MARKER_CALL(vfork);
    errno = ENOSYS;
    return (pid_t)-1;
}
