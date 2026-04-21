#include <signal.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#ifndef NSIG
#define NSIG 64
#endif

static struct sigaction codepod_signal_actions[NSIG];
static int codepod_signal_initialized = 0;
static unsigned codepod_alarm_seconds = 0;
static unsigned long long codepod_signal_mask = 0;

static int codepod_signal_validate(int sig);
static int codepod_sigset_mask_bit(int sig, sigset_t *bit);

static int codepod_signal_bit(int sig, unsigned long long *bit) {
  if (codepod_signal_validate(sig) != 0) {
    return -1;
  }
  if (sig >= (int)(8 * sizeof(codepod_signal_mask))) {
    errno = EINVAL;
    return -1;
  }
  *bit = 1ull << sig;
  return 0;
}

static int codepod_sigset_mask_bit(int sig, sigset_t *bit) {
  if (codepod_signal_validate(sig) != 0) {
    return -1;
  }
  if (sig >= (int)(8 * sizeof(sigset_t))) {
    errno = EINVAL;
    return -1;
  }
  *bit = (sigset_t)(((unsigned long long)1u) << sig);
  return 0;
}

static void codepod_signal_init(void) {
  if (codepod_signal_initialized) {
    return;
  }

  for (int i = 0; i < NSIG; ++i) {
    memset(&codepod_signal_actions[i], 0, sizeof(codepod_signal_actions[i]));
    codepod_signal_actions[i].sa_handler = SIG_DFL;
  }

  codepod_signal_initialized = 1;
}

static int codepod_signal_validate(int sig) {
  if (sig <= 0 || sig >= NSIG) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int sigemptyset(sigset_t *set) {
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  *set = 0;
  return 0;
}

int sigfillset(sigset_t *set) {
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  *set = ~(sigset_t)0;
  return 0;
}

int sigaddset(sigset_t *set, int sig) {
  sigset_t bit;

  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (codepod_sigset_mask_bit(sig, &bit) != 0) {
    return -1;
  }

  *set |= bit;
  return 0;
}

int sigdelset(sigset_t *set, int sig) {
  sigset_t bit;

  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (codepod_sigset_mask_bit(sig, &bit) != 0) {
    return -1;
  }

  *set &= ~bit;
  return 0;
}

int sigismember(const sigset_t *set, int sig) {
  sigset_t bit;

  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (codepod_sigset_mask_bit(sig, &bit) != 0) {
    return -1;
  }

  return (*set & bit) != 0;
}

sighandler_t signal(int sig, sighandler_t handler) {
  sighandler_t old_handler;

  if (codepod_signal_validate(sig) != 0) {
    return SIG_ERR;
  }

  codepod_signal_init();
  old_handler = codepod_signal_actions[sig].sa_handler;
  codepod_signal_actions[sig].sa_handler = handler;
  memset(&codepod_signal_actions[sig].sa_mask, 0, sizeof(codepod_signal_actions[sig].sa_mask));
  codepod_signal_actions[sig].sa_flags = 0;
  codepod_signal_actions[sig].sa_restorer = NULL;
  return old_handler;
}

int sigaction(int sig, const struct sigaction *restrict act, struct sigaction *restrict oldact) {
  if (codepod_signal_validate(sig) != 0) {
    return -1;
  }

  codepod_signal_init();

  if (oldact) {
    *oldact = codepod_signal_actions[sig];
  }
  if (act) {
    codepod_signal_actions[sig] = *act;
  }

  return 0;
}

int sigprocmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset) {
  codepod_signal_init();

  if (oldset) {
    *oldset = (sigset_t)codepod_signal_mask;
  }
  if (set == NULL) {
    return 0;
  }

  switch (how) {
    case SIG_BLOCK:
      codepod_signal_mask |= (unsigned long long)(*set);
      return 0;
    case SIG_UNBLOCK:
      codepod_signal_mask &= ~((unsigned long long)(*set));
      return 0;
    case SIG_SETMASK:
      codepod_signal_mask = (unsigned long long)(*set);
      return 0;
    default:
      errno = EINVAL;
      return -1;
  }
}

int sigsuspend(const sigset_t *mask) {
  (void)mask;
  errno = EINTR;
  return -1;
}

int raise(int sig) {
  sighandler_t handler;
  unsigned long long bit;

  if (codepod_signal_validate(sig) != 0) {
    return -1;
  }

  codepod_signal_init();
  if (codepod_signal_bit(sig, &bit) != 0) {
    return -1;
  }
  if ((codepod_signal_mask & bit) != 0) {
    return 0;
  }

  handler = codepod_signal_actions[sig].sa_handler;

  if (handler == SIG_IGN) {
    return 0;
  }
  if (handler != SIG_DFL && handler != SIG_ERR && handler != NULL) {
    handler(sig);
    return 0;
  }

  if (sig == SIGINT || sig == SIGTERM || sig == SIGALRM) {
    _Exit(128 + sig);
  }

  return 0;
}

unsigned alarm(unsigned seconds) {
  unsigned previous = codepod_alarm_seconds;
  codepod_alarm_seconds = seconds;
  return previous;
}
