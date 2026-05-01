#ifndef CODEPOD_COMPAT_POLL_H
#define CODEPOD_COMPAT_POLL_H

#include_next <poll.h>

#ifndef POLLPRI
#define POLLPRI 0x0002
#endif

#endif
