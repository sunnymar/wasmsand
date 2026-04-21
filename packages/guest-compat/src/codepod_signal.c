#include <signal.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include "codepod_markers.h"

CODEPOD_DECLARE_MARKER(signal);
CODEPOD_DECLARE_MARKER(sigaction);
CODEPOD_DECLARE_MARKER(raise);
CODEPOD_DECLARE_MARKER(alarm);
CODEPOD_DECLARE_MARKER(sigemptyset);
CODEPOD_DECLARE_MARKER(sigfillset);
CODEPOD_DECLARE_MARKER(sigaddset);
CODEPOD_DECLARE_MARKER(sigdelset);
CODEPOD_DECLARE_MARKER(sigismember);
CODEPOD_DECLARE_MARKER(sigprocmask);
CODEPOD_DECLARE_MARKER(sigsuspend);

CODEPOD_DEFINE_MARKER(signal,       0x73676e6cu) /* sgnl */
CODEPOD_DEFINE_MARKER(sigaction,    0x73676163u) /* sgac */
CODEPOD_DEFINE_MARKER(raise,        0x72616973u) /* rais */
CODEPOD_DEFINE_MARKER(alarm,        0x616c726du) /* alrm */
CODEPOD_DEFINE_MARKER(sigemptyset,  0x73656d70u) /* semp */
CODEPOD_DEFINE_MARKER(sigfillset,   0x7366696cu) /* sfil */
CODEPOD_DEFINE_MARKER(sigaddset,    0x73616464u) /* sadd */
CODEPOD_DEFINE_MARKER(sigdelset,    0x7364656cu) /* sdel */
CODEPOD_DEFINE_MARKER(sigismember,  0x7369736du) /* sism */
CODEPOD_DEFINE_MARKER(sigprocmask,  0x7370726du) /* sprm */
CODEPOD_DEFINE_MARKER(sigsuspend,   0x73737370u) /* sssp */

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
  CODEPOD_MARKER_CALL(sigemptyset);
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  *set = 0;
  return 0;
}

int sigfillset(sigset_t *set) {
  CODEPOD_MARKER_CALL(sigfillset);
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  *set = ~(sigset_t)0;
  return 0;
}

int sigaddset(sigset_t *set, int sig) {
  CODEPOD_MARKER_CALL(sigaddset);
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
  CODEPOD_MARKER_CALL(sigdelset);
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
  CODEPOD_MARKER_CALL(sigismember);
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
  CODEPOD_MARKER_CALL(signal);
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
  CODEPOD_MARKER_CALL(sigaction);
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
  CODEPOD_MARKER_CALL(sigprocmask);
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
  CODEPOD_MARKER_CALL(sigsuspend);
  (void)mask;
  errno = EINTR;
  return -1;
}

int raise(int sig) {
  CODEPOD_MARKER_CALL(raise);
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
  CODEPOD_MARKER_CALL(alarm);
  unsigned previous = codepod_alarm_seconds;
  codepod_alarm_seconds = seconds;
  return previous;
}
