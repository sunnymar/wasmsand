#include <stdio.h>
#include <unistd.h>

int main(void) {
  if (dup2(1, 2) < 0) {
    perror("dup2");
    return 1;
  }

  if (fprintf(stderr, "dup2-ok\n") < 0) {
    return 1;
  }

  return 0;
}
