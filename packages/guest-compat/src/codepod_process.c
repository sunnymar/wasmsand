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
