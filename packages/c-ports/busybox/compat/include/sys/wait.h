#ifndef CODEPOD_BUSYBOX_COMPAT_SYS_WAIT_H
#define CODEPOD_BUSYBOX_COMPAT_SYS_WAIT_H

#include <sys/types.h>

#ifndef WNOHANG
#define WNOHANG 0x00000001
#endif

#ifndef WUNTRACED
#define WUNTRACED 0x00000002
#endif

#ifndef WEXITSTATUS
#define WEXITSTATUS(status) (((status) >> 8) & 0xff)
#endif

#ifndef WTERMSIG
#define WTERMSIG(status) ((status) & 0x7f)
#endif

#ifndef WSTOPSIG
#define WSTOPSIG(status) WEXITSTATUS(status)
#endif

#ifndef WIFEXITED
#define WIFEXITED(status) (WTERMSIG(status) == 0)
#endif

#ifndef WIFSIGNALED
#define WIFSIGNALED(status) (((signed char)(((status) & 0x7f) + 1) >> 1) > 0)
#endif

#ifndef WIFSTOPPED
#define WIFSTOPPED(status) (((status) & 0xff) == 0x7f)
#endif

pid_t wait(int *status);
pid_t waitpid(pid_t pid, int *status, int options);
pid_t wait3(int *status, int options, void *rusage);
pid_t wait4(pid_t pid, int *status, int options, void *rusage);

#endif
