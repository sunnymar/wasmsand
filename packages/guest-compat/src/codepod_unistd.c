#include "codepod_runtime.h"

#include <errno.h>
#include <unistd.h>

int dup2(int oldfd, int newfd) {
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
  if (size < 0) {
    errno = EINVAL;
    return -1;
  }
  if (size == 0) {
    return 1;
  }
  if (list == NULL) {
    errno = EINVAL;
    return -1;
  }

  list[0] = (gid_t) 0;
  return 1;
}
