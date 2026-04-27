/* pthread-canary — verifies the codepod pthread Tier 1 surface.
 *
 * Spawns 4 threads, each increments a shared counter 10000 times
 * under a mutex, joins all of them, and asserts the final counter
 * value is 40000.  On a real-thread backend this exercises real
 * mutual exclusion across cores; on the codepod cooperative
 * scheduler it exercises the scheduler's mutex/cond primitives and
 * the context-switch path through every host import.
 *
 * The canary writes a single line "pthread:ok" to stdout on success
 * (the conformance harness asserts on this exact string).  Any
 * counter mismatch, join failure, or mutex error path emits a
 * diagnostic to stderr and exits non-zero.
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NUM_THREADS  4
#define ITERS_PER_THREAD 10000
#define EXPECTED (NUM_THREADS * ITERS_PER_THREAD)

static int            shared_counter = 0;
static pthread_mutex_t shared_lock   = PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *arg) {
  int id = (int)(long)arg;
  for (int i = 0; i < ITERS_PER_THREAD; i++) {
    int rc = pthread_mutex_lock(&shared_lock);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: mutex_lock returned %d in thread %d\n", rc, id);
      return (void *)1;
    }
    shared_counter++;
    rc = pthread_mutex_unlock(&shared_lock);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: mutex_unlock returned %d in thread %d\n", rc, id);
      return (void *)1;
    }
  }
  return NULL;
}

int main(void) {
  pthread_t tids[NUM_THREADS];
  for (long i = 0; i < NUM_THREADS; i++) {
    int rc = pthread_create(&tids[i], NULL, worker, (void *)i);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: pthread_create #%ld returned %d\n", i, rc);
      return 2;
    }
  }
  for (int i = 0; i < NUM_THREADS; i++) {
    void *retval = NULL;
    int rc = pthread_join(tids[i], &retval);
    if (rc != 0) {
      fprintf(stderr, "pthread-canary: pthread_join #%d returned %d\n", i, rc);
      return 3;
    }
    if (retval != NULL) {
      fprintf(stderr, "pthread-canary: thread #%d returned non-null %p\n", i, retval);
      return 4;
    }
  }
  if (shared_counter != EXPECTED) {
    fprintf(stderr,
            "pthread-canary: counter race: got %d, expected %d (lost %d updates)\n",
            shared_counter, EXPECTED, EXPECTED - shared_counter);
    return 5;
  }
  printf("pthread:ok\n");
  return 0;
}
