/* Timezone surface — wasi-libc gates `tzset`, `tzname[]`, `timezone`,
 * `daylight` behind __wasilibc_unmodified_upstream because WASI has
 * no timezone database.  Codepod's clock is host Date.now() in UTC,
 * so the right surface is "expose the symbols, leave the values at
 * their UTC defaults".  This lets POSIX C code link cleanly.
 *
 * tzset(2) re-reads $TZ on glibc and updates tzname/timezone/daylight.
 * Here it's a no-op; UTC is the only zone we model.
 */

#include <errno.h>
#include <time.h>

#include "codepod_markers.h"

CODEPOD_DECLARE_MARKER(tzset);
CODEPOD_DECLARE_MARKER(clock_settime);
CODEPOD_DEFINE_MARKER(tzset, 0x747a7374u) /* "tzst" */
CODEPOD_DEFINE_MARKER(clock_settime, 0x6373746du) /* "cstm" */

/* Mutable storage so callers that take addresses (e.g. `&tzname[0]`)
 * see consistent values.  The "GMT" string is the universal default
 * — matches what glibc reports on a system without /etc/localtime. */
static char codepod_tzname_std[] = "GMT";
static char codepod_tzname_dst[] = "GMT";

char *tzname[2] = { codepod_tzname_std, codepod_tzname_dst };
long timezone = 0;
int daylight = 0;

void tzset(void) {
  CODEPOD_MARKER_CALL(tzset);
  /* No-op: codepod is UTC-only; tzname/timezone/daylight stay at
   * their initialized values above. */
}

int clock_settime(clockid_t clockid, const struct timespec *tp) {
  CODEPOD_MARKER_CALL(clock_settime);
  (void)clockid;
  (void)tp;
  errno = ENOSYS;
  return -1;
}
