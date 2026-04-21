#ifndef CODEPOD_COMPAT_SIGNAL_H
#define CODEPOD_COMPAT_SIGNAL_H

#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>

#if !defined(__wasilibc___typedef_sigset_t_h) && !defined(__DEFINED_sigset_t)
typedef unsigned char sigset_t;
#define __DEFINED_sigset_t
#endif

typedef void (*sighandler_t)(int);

#define SIGHUP 1
#define SIGINT 2
#define SIGQUIT 3
#define SIGILL 4
#define SIGABRT 6
#define SIGKILL 9
#define SIGALRM 14
#define SIGTERM 15
#define SIGCHLD 17
#define SIGCONT 18
#define SIGSTOP 19
#define SIGTSTP 20
#define SIGTTIN 21
#define SIGTTOU 22
#define SIGURG 23
#define SIGXCPU 24
#define SIGXFSZ 25
#define SIGVTALRM 26
#define SIGUSR1 10
#define SIGUSR2 12
#define SIGPIPE 13

#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2

#define SA_RESTART 0x10000000

#define SIG_DFL ((sighandler_t)(intptr_t)0)
#define SIG_IGN ((sighandler_t)(intptr_t)-2)
#define SIG_ERR ((sighandler_t)(intptr_t)-1)

struct sigaction {
  union {
    sighandler_t sa_handler;
    void (*sa_sigaction)(int, void *, void *);
  } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};

#define sa_handler __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction

int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);

sighandler_t signal(int sig, sighandler_t handler);
int sigaction(int sig, const struct sigaction *restrict act, struct sigaction *restrict oldact);
int sigprocmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset);
int sigsuspend(const sigset_t *mask);
int raise(int sig);
unsigned alarm(unsigned seconds);

#endif
