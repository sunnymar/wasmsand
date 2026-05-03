/* Strong fork(2) shim for Codepod continuation builds.
 *
 * The always-linked compatibility archive keeps weak fork/vfork stubs that
 * return ENOSYS.  libcodepod_continuations.a links this object so continuation
 * builds import codepod.host_fork and let the Asyncify runtime split the
 * parent/child return.
 */

#include <errno.h>
#include <sys/types.h>
#include <unistd.h>

#include "codepod_markers.h"
#include "codepod_runtime.h"

CODEPOD_DECLARE_MARKER(fork);

pid_t fork(void) {
    CODEPOD_MARKER_CALL(fork);
    int rc = codepod_host_fork();
    if (rc < 0) {
        errno = -rc;
        return (pid_t)-1;
    }
    return (pid_t)rc;
}
