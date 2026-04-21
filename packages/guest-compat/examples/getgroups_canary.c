#include <stdio.h>
#include <unistd.h>

int main(void) {
  gid_t groups[1];
  int count = getgroups(0, NULL);

  if (count != 1) {
    fprintf(stderr, "unexpected group count: %d\n", count);
    return 1;
  }

  count = getgroups(1, groups);
  if (count != 1) {
    fprintf(stderr, "unexpected getgroups result: %d\n", count);
    return 1;
  }

  printf("getgroups:%d:%u\n", count, (unsigned) groups[0]);
  return 0;
}
