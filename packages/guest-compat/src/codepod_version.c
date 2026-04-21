#include <stdint.h>

#include "codepod_compat.h"

uint32_t codepod_guest_compat_version =
  ((uint32_t)CODEPOD_GUEST_COMPAT_VERSION_MAJOR << 16) |
  (uint32_t)CODEPOD_GUEST_COMPAT_VERSION_MINOR;
