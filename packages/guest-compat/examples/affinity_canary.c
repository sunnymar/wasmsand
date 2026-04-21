#include <sched.h>

#include <errno.h>
#include <stdio.h>

int main(void) {
  cpu_set_t mask;
  int get_count;
  int set0_rc;
  int set1_errno;

  CPU_ZERO(&mask);
  if (sched_getaffinity(0, sizeof(mask), &mask) != 0) {
    perror("sched_getaffinity");
    return 1;
  }
  get_count = CPU_COUNT(&mask);

  CPU_ZERO(&mask);
  CPU_SET(0, &mask);
  set0_rc = sched_setaffinity(0, sizeof(mask), &mask);
  if (set0_rc != 0) {
    perror("sched_setaffinity cpu0");
    return 1;
  }

  CPU_ZERO(&mask);
  CPU_SET(1, &mask);
  if (sched_setaffinity(0, sizeof(mask), &mask) == 0) {
    fprintf(stderr, "sched_setaffinity unexpectedly accepted cpu1\n");
    return 1;
  }
  set1_errno = errno;

  if (set1_errno != EINVAL) {
    fprintf(stderr, "unexpected errno: %d\n", set1_errno);
    return 1;
  }

  printf("affinity:get=%d,set0=%d,set1=einval\n", get_count, set0_rc);
  return 0;
}
