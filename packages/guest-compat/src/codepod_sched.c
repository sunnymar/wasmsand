#include <sched.h>

#include <errno.h>
#include <stddef.h>
#include <string.h>
#include "codepod_markers.h"

CODEPOD_DECLARE_MARKER(sched_getaffinity);
CODEPOD_DECLARE_MARKER(sched_setaffinity);
CODEPOD_DECLARE_MARKER(sched_getcpu);

CODEPOD_DEFINE_MARKER(sched_getaffinity, 0x73676166u) /* sgaf */
CODEPOD_DEFINE_MARKER(sched_setaffinity, 0x73736166u) /* ssaf */
CODEPOD_DEFINE_MARKER(sched_getcpu,      0x73676370u) /* sgcp */

static int codepod_sched_validate_size(size_t cpusetsize) {
  if (cpusetsize < sizeof(cpu_set_t)) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask) {
  CODEPOD_MARKER_CALL(sched_getaffinity);
  (void)pid;

  if (!mask) {
    errno = EINVAL;
    return -1;
  }
  if (codepod_sched_validate_size(cpusetsize) != 0) {
    return -1;
  }

  memset(mask, 0, cpusetsize);
  CPU_SET(0, mask);
  return 0;
}

int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask) {
  CODEPOD_MARKER_CALL(sched_setaffinity);
  const unsigned char *bytes;
  size_t i;
  unsigned long first_word;

  (void)pid;

  if (!mask) {
    errno = EINVAL;
    return -1;
  }
  if (codepod_sched_validate_size(cpusetsize) != 0) {
    return -1;
  }

  first_word = mask->__bits[0];
  if (first_word != 1ul) {
    errno = EINVAL;
    return -1;
  }

  bytes = (const unsigned char *)mask;
  for (i = sizeof(unsigned long); i < cpusetsize; ++i) {
    if (bytes[i] != 0) {
      errno = EINVAL;
      return -1;
    }
  }

  return 0;
}

int sched_getcpu(void) {
  CODEPOD_MARKER_CALL(sched_getcpu);
  return 0;
}
