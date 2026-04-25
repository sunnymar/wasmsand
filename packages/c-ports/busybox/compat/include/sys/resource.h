#ifndef CODEPOD_BUSYBOX_COMPAT_SYS_RESOURCE_H
#define CODEPOD_BUSYBOX_COMPAT_SYS_RESOURCE_H

/* wasi-libc has no <sys/resource.h>.  Provide just enough surface for
 * BusyBox applets that touch resource limits / priorities — they all
 * stub to "no-op success" because the sandbox doesn't expose process
 * priorities or rlimit state to the guest. */

#include <errno.h>
#include <sys/types.h>

/* getpriority/setpriority — `which` selectors. */
#define PRIO_PROCESS 0
#define PRIO_PGRP    1
#define PRIO_USER    2

typedef unsigned long rlim_t;
struct rlimit {
    rlim_t rlim_cur;
    rlim_t rlim_max;
};

#define RLIMIT_CPU      0
#define RLIMIT_FSIZE    1
#define RLIMIT_DATA     2
#define RLIMIT_STACK    3
#define RLIMIT_CORE     4
#define RLIMIT_RSS      5
#define RLIMIT_NPROC    6
#define RLIMIT_NOFILE   7
#define RLIMIT_MEMLOCK  8
#define RLIMIT_AS       9
#define RLIMIT_LOCKS   10
#define RLIMIT_SIGPENDING 11
#define RLIMIT_MSGQUEUE 12
#define RLIMIT_NICE    13
#define RLIMIT_RTPRIO  14
#define RLIM_INFINITY ((rlim_t)-1)

struct rusage {
    struct timeval ru_utime;
    struct timeval ru_stime;
    long ru_maxrss, ru_ixrss, ru_idrss, ru_isrss;
    long ru_minflt, ru_majflt, ru_nswap;
    long ru_inblock, ru_oublock, ru_msgsnd, ru_msgrcv;
    long ru_nsignals, ru_nvcsw, ru_nivcsw;
};
#define RUSAGE_SELF     0
#define RUSAGE_CHILDREN (-1)

static inline int getpriority(int which, id_t who) {
    (void)which; (void)who;
    /* "default" niceness — caller can't tell us apart from a real 0. */
    return 0;
}

static inline int setpriority(int which, id_t who, int prio) {
    (void)which; (void)who; (void)prio;
    /* Sandbox priority isn't user-visible; accept silently. */
    return 0;
}

static inline int getrlimit(int resource, struct rlimit *rlim) {
    (void)resource;
    if (rlim) { rlim->rlim_cur = RLIM_INFINITY; rlim->rlim_max = RLIM_INFINITY; }
    return 0;
}

static inline int setrlimit(int resource, const struct rlimit *rlim) {
    (void)resource; (void)rlim;
    return 0;
}

static inline int getrusage(int who, struct rusage *r) {
    (void)who;
    if (r) {
        struct rusage zero = {0};
        *r = zero;
    }
    return 0;
}

#endif /* CODEPOD_BUSYBOX_COMPAT_SYS_RESOURCE_H */
