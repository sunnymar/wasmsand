#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

static int signal_canary_seen = 0;

static void signal_canary_handler(int sig) { signal_canary_seen = sig; }

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

/* Existing Step 1 case, refactored. Task 6 adds the rest of the signal family. */
static int case_sigaction_raise(void) {
  struct sigaction sa;
  signal_canary_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;
  if (sigaction(SIGINT, &sa, NULL) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (raise(SIGINT) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (signal_canary_seen != SIGINT) { emit("sigaction_raise", 1, NULL, 0, 0); return 1; }
  emit("sigaction_raise", 0, "signal-ok", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "sigaction_raise") == 0) return case_sigaction_raise();
  fprintf(stderr, "signal-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("sigaction_raise");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved for guest-compat.test.ts. */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = signal_canary_handler;
    if (sigaction(SIGINT, &sa, NULL) != 0) { perror("sigaction"); return 1; }
    if (raise(SIGINT) != 0) { perror("raise"); return 1; }
    if (signal_canary_seen != SIGINT) { fprintf(stderr, "signal handler was not invoked\n"); return 1; }
    alarm(0);
    puts("signal-ok");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: signal-canary [--case <name> | --list-cases]\n");
  return 2;
}
