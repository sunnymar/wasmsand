#include <signal.h>

#include <stdio.h>
#include <string.h>

static int signal_canary_seen = 0;

static void signal_canary_handler(int sig) { signal_canary_seen = sig; }

int main(void) {
  struct sigaction sa;

  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;

  if (sigaction(SIGINT, &sa, NULL) != 0) {
    perror("sigaction");
    return 1;
  }

  if (raise(SIGINT) != 0) {
    perror("raise");
    return 1;
  }
  if (signal_canary_seen != SIGINT) {
    fprintf(stderr, "signal handler was not invoked\n");
    return 1;
  }

  alarm(0);
  puts("signal-ok");
  return 0;
}
