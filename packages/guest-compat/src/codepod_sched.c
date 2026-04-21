#include <sched.h>

#include <errno.h>
#include <stddef.h>
#include <string.h>

static int codepod_sched_validate_size(size_t cpusetsize) {
  if (cpusetsize < sizeof(cpu_set_t)) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask) {
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
  return 0;
}
