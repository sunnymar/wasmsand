#include "codepod_runtime.h"
#include "codepod_markers.h"

#include <errno.h>
#include <unistd.h>

CODEPOD_DECLARE_MARKER(dup2);
CODEPOD_DECLARE_MARKER(getgroups);

CODEPOD_DEFINE_MARKER(dup2, 0x64703200u)      /* "dp2\0" */
CODEPOD_DEFINE_MARKER(getgroups, 0x67677270u) /* "ggrp" */

int dup2(int oldfd, int newfd) {
  CODEPOD_MARKER_CALL(dup2);

  if (oldfd < 0 || newfd < 0) {
    errno = EINVAL;
    return -1;
  }

  if (oldfd == newfd) {
    return newfd;
  }

  if (codepod_host_dup2(oldfd, newfd) != 0) {
    errno = EBADF;
    return -1;
  }

  return newfd;
}

int getgroups(int size, gid_t list[]) {
  CODEPOD_MARKER_CALL(getgroups);

  if (size < 0) {
    errno = EINVAL;
    return -1;
  }
  /* Sandbox is single-user: report exactly the primary group (1000),
   * matching getegid() / `id` output.  POSIX: size==0 means "tell me
   * how many entries", so we return the count without writing list. */
  if (size == 0) {
    return 1;
  }
  if (list == NULL) {
    errno = EINVAL;
    return -1;
  }

  list[0] = (gid_t) 1000;
  return 1;
}
