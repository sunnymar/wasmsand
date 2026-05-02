#include <pthread.h>
#include <stdio.h>

#define NUM_THREADS 4
#define ITERS_PER_THREAD 10000
#define EXPECTED (NUM_THREADS * ITERS_PER_THREAD)

static int shared_counter = 0;
static pthread_mutex_t shared_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_key_t tls_key;

static void *worker(void *arg) {
  int id = (int)(long)arg;
  long initial_tls_value = (long)pthread_getspecific(tls_key);
  if (initial_tls_value != 0) {
    fprintf(stderr, "pthread-canary: initial tls mismatch in thread %d: got %ld\n", id, initial_tls_value);
    return (void *)1;
  }
  if (pthread_setspecific(tls_key, (void *)(long)(id + 100)) != 0) {
    fprintf(stderr, "pthread-canary: pthread_setspecific failed in thread %d\n", id);
    return (void *)1;
  }
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
  long tls_value = (long)pthread_getspecific(tls_key);
  if (tls_value != id + 100) {
    fprintf(stderr, "pthread-canary: tls mismatch in thread %d: got %ld\n", id, tls_value);
    return (void *)1;
  }
  return NULL;
}

int main(void) {
  if (pthread_key_create(&tls_key, NULL) != 0) {
    fprintf(stderr, "pthread-canary: pthread_key_create failed\n");
    return 1;
  }
  if (pthread_setspecific(tls_key, (void *)999) != 0) {
    fprintf(stderr, "pthread-canary: main pthread_setspecific failed\n");
    return 1;
  }
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
    fprintf(stderr, "pthread-canary: counter race: got %d, expected %d\n", shared_counter, EXPECTED);
    return 5;
  }
  printf("pthread:ok\n");
  return 0;
}
