#include <stdio.h>
#include "mbedtls/version.h"

int main(void) {
  char version[64];
  mbedtls_version_get_string_full(version);
  printf("%s\n", version);
  return 0;
}
