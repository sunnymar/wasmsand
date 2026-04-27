/* pthread Tier 1 frontend — backend-routed implementation.
 *
 * Every Tier 1 entry thunks through `codepod::host_*` imports.  No
 * inline shortcuts: the host import path *is* the implementation.
 * That keeps the same .wasm running correctly on every codepod
 * backend (cooperative-serial / wasi-threads / Worker+SAB / WASI
 * Preview 2) — only the backend-side host import implementation
 * varies.  See
 * docs/superpowers/specs/2026-04-27-wasi-threads-design.md.
 *
 * Implementation notes:
 *
 * - pthread_t is a 32-bit thread id allocated by the backend.  The
 *   C frontend stores nothing about thread state — it round-trips
 *   the id through host imports.  Same for pthread_mutex_t /
 *   pthread_cond_t: the C frontend passes a pointer to the struct's
 *   first opaque slot to the backend, which interprets it however
 *   it likes (atomic-CAS state, futex word, scheduler-side ledger
 *   key).  This means PTHREAD_MUTEX_INITIALIZER zero-init is the
 *   right "lazily ready" state — no first-use init call needed.
 *
 * - Thread-local storage (`pthread_key_*`, `pthread_setspecific`)
 *   stays C-side as a flat per-process map: under the
 *   cooperative-serial backend the "current" thread is unique by
 *   construction (single OS thread, sequential execution), so a
 *   single value-per-key is correct.  The wasi-threads / Worker+SAB
 *   backends will replace this file's TLS with a real per-thread
 *   table backed by `__wasilibc_set_tls_base` or equivalent — the
 *   pthread.h surface stays the same.
 *
 * - pthread_once carries its own done-flag in the pthread_once_t
 *   layout we expose; correct under cooperative-serial because
 *   nothing can interleave the check + body.  Future real-thread
 *   backends will need atomic test-and-set semantics on
 *   once_control->done — wide enough (`int`) to hold a CAS state.
 */

#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "codepod_markers.h"
#include "codepod_runtime.h"

CODEPOD_DECLARE_MARKER(pthread_create);
CODEPOD_DECLARE_MARKER(pthread_join);
CODEPOD_DECLARE_MARKER(pthread_detach);
CODEPOD_DECLARE_MARKER(pthread_exit);
CODEPOD_DECLARE_MARKER(pthread_self);
CODEPOD_DECLARE_MARKER(pthread_mutex_lock);
CODEPOD_DECLARE_MARKER(pthread_mutex_unlock);
CODEPOD_DECLARE_MARKER(pthread_cond_wait);
CODEPOD_DECLARE_MARKER(pthread_cond_signal);
CODEPOD_DECLARE_MARKER(pthread_key_create);
CODEPOD_DECLARE_MARKER(pthread_setspecific);
CODEPOD_DECLARE_MARKER(pthread_getspecific);
CODEPOD_DECLARE_MARKER(pthread_once);

CODEPOD_DEFINE_MARKER(pthread_create,      0x70637274u) /* pcrt */
CODEPOD_DEFINE_MARKER(pthread_join,        0x706a6f69u) /* pjoi */
CODEPOD_DEFINE_MARKER(pthread_detach,      0x70646574u) /* pdet */
CODEPOD_DEFINE_MARKER(pthread_exit,        0x70657874u) /* pext */
CODEPOD_DEFINE_MARKER(pthread_self,        0x7073656cu) /* psel */
CODEPOD_DEFINE_MARKER(pthread_mutex_lock,  0x706d6c6bu) /* pmlk */
CODEPOD_DEFINE_MARKER(pthread_mutex_unlock,0x706d756cu) /* pmul */
CODEPOD_DEFINE_MARKER(pthread_cond_wait,   0x70637774u) /* pcwt */
CODEPOD_DEFINE_MARKER(pthread_cond_signal, 0x70637367u) /* pcsg */
CODEPOD_DEFINE_MARKER(pthread_key_create,  0x70726b63u) /* pkkc */
CODEPOD_DEFINE_MARKER(pthread_setspecific, 0x70737073u) /* psps */
CODEPOD_DEFINE_MARKER(pthread_getspecific, 0x70677073u) /* pgps */
CODEPOD_DEFINE_MARKER(pthread_once,        0x706f6e63u) /* ponc */

/* Backend-storage size sanity: wasi-libc's pthread types are
 * 40-byte unions (10 ints) — plenty of room for atomic-CAS state
 * + waiter counts when the real-thread backends arrive.  Pin the
 * minimum so a future wasi-libc version can't silently shrink
 * the layout out from under us. */
_Static_assert(sizeof(pthread_mutex_t) >= 16,
               "pthread_mutex_t needs >=16 bytes for backend state");
_Static_assert(sizeof(pthread_cond_t)  >= 16,
               "pthread_cond_t needs >=16 bytes for backend state");

/* ── Lifecycle ───────────────────────────────────────────────
 *
 * The function pointer arrives as a function-table index.  C casts
 * it to int via __builtin_pthread_self_func (no — actually clang
 * passes function pointers as table indices verbatim under
 * wasm32-wasip1; the cast through (int) gives us the table index
 * the host can pass to __indirect_function_table.get).
 *
 * The `arg` is just a pointer cast to int.  Both spawn and join go
 * through async-wrapped host imports so the wasm stack suspends
 * (JSPI) or unwinds-rewinds (Asyncify) at every boundary — the
 * yield-point story is uniform with the rest of guest-compat.
 */

int pthread_create(pthread_t *thread,
                   const pthread_attr_t *attr,
                   void *(*start_routine)(void *),
                   void *arg) {
  CODEPOD_MARKER_CALL(pthread_create);
  (void)attr;  /* attrs accepted but the cooperative-serial backend
                * ignores them; future backends may honor stack-size,
                * detach-state. */
  if (!thread || !start_routine) return EINVAL;

  int tid = codepod_host_thread_spawn((int)(intptr_t)start_routine,
                                      (int)(intptr_t)arg);
  if (tid < 0) return EAGAIN;
  *thread = (pthread_t)tid;
  return 0;
}

int pthread_join(pthread_t thread, void **retval) {
  CODEPOD_MARKER_CALL(pthread_join);
  int rv = codepod_host_thread_join((int)thread);
  if (rv == -1) return ESRCH;  /* host signals invalid tid as -1 */
  if (retval) *retval = (void *)(intptr_t)rv;
  return 0;
}

int pthread_detach(pthread_t thread) {
  CODEPOD_MARKER_CALL(pthread_detach);
  if (codepod_host_thread_detach((int)thread) < 0) return ESRCH;
  return 0;
}

void pthread_exit(void *retval) {
  CODEPOD_MARKER_CALL(pthread_exit);
  /* Cooperative-serial: the only sane interpretation is "exit the
   * program with retval-as-int" — we have no scheduler frame to
   * unwind to.  Real-thread backends override this whole function
   * via the alternate compat archive; no behavior change for guests. */
  exit(retval ? 1 : 0);
}

pthread_t pthread_self(void) {
  CODEPOD_MARKER_CALL(pthread_self);
  return (pthread_t)codepod_host_thread_self();
}

int pthread_equal(pthread_t a, pthread_t b) {
  return a == b;
}

/* ── Mutex ───────────────────────────────────────────────────
 *
 * Pass the address of the mutex's first opaque slot to the host.
 * The host treats that pointer as a backend-defined u64 — for
 * cooperative-serial it's ignored, for wasi-threads it's the futex
 * word, for Worker+SAB it's the Atomics.wait address.  Either way
 * the C side just round-trips the pointer.
 */

int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr) {
  if (!mutex) return EINVAL;
  (void)attr;
  memset(mutex, 0, sizeof(*mutex));
  return 0;
}

int pthread_mutex_destroy(pthread_mutex_t *mutex) {
  if (!mutex) return EINVAL;
  return 0;
}

int pthread_mutex_lock(pthread_mutex_t *mutex) {
  CODEPOD_MARKER_CALL(pthread_mutex_lock);
  if (!mutex) return EINVAL;
  return codepod_host_mutex_lock((int)(intptr_t)mutex);
}

int pthread_mutex_unlock(pthread_mutex_t *mutex) {
  CODEPOD_MARKER_CALL(pthread_mutex_unlock);
  if (!mutex) return EINVAL;
  return codepod_host_mutex_unlock((int)(intptr_t)mutex);
}

int pthread_mutex_trylock(pthread_mutex_t *mutex) {
  if (!mutex) return EINVAL;
  return codepod_host_mutex_trylock((int)(intptr_t)mutex);
}

/* ── Cond ────────────────────────────────────────────────── */

int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr) {
  if (!cond) return EINVAL;
  (void)attr;
  memset(cond, 0, sizeof(*cond));
  return 0;
}

int pthread_cond_destroy(pthread_cond_t *cond) {
  if (!cond) return EINVAL;
  return 0;
}

int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
  CODEPOD_MARKER_CALL(pthread_cond_wait);
  if (!cond || !mutex) return EINVAL;
  return codepod_host_cond_wait((int)(intptr_t)cond,
                                (int)(intptr_t)mutex);
}

int pthread_cond_timedwait(pthread_cond_t *cond,
                           pthread_mutex_t *mutex,
                           const struct timespec *abstime) {
  if (!cond || !mutex) return EINVAL;
  /* Step 1 collapses timed-wait into untimed-wait — backends that
   * care about timeouts will plumb abstime through a dedicated host
   * import. */
  (void)abstime;
  return codepod_host_cond_wait((int)(intptr_t)cond,
                                (int)(intptr_t)mutex);
}

int pthread_cond_signal(pthread_cond_t *cond) {
  CODEPOD_MARKER_CALL(pthread_cond_signal);
  if (!cond) return EINVAL;
  return codepod_host_cond_signal((int)(intptr_t)cond);
}

int pthread_cond_broadcast(pthread_cond_t *cond) {
  if (!cond) return EINVAL;
  return codepod_host_cond_broadcast((int)(intptr_t)cond);
}

/* ── Thread-local storage (C-side, single-thread-correct) ─────
 *
 * Cooperative-serial: a single value per key is correct because
 * there's never more than one logical "active" thread at the C
 * level (each pthread_create's start_routine runs to completion
 * before the next one starts).  When real-thread backends land,
 * the same TLS API gets reimplemented with __wasilibc_set_tls_base
 * per-thread switching, but the pthread.h surface stays identical.
 */

#define CODEPOD_TLS_KEYS_MAX  64

typedef struct {
  int                  in_use;
  void               (*destructor)(void *);
  void                *value;
} tls_key_t;

static tls_key_t tls_keys[CODEPOD_TLS_KEYS_MAX];

int pthread_key_create(pthread_key_t *key, void (*destructor)(void *)) {
  CODEPOD_MARKER_CALL(pthread_key_create);
  if (!key) return EINVAL;
  for (unsigned int i = 0; i < CODEPOD_TLS_KEYS_MAX; i++) {
    if (!tls_keys[i].in_use) {
      tls_keys[i].in_use     = 1;
      tls_keys[i].destructor = destructor;
      tls_keys[i].value      = NULL;
      *key = (pthread_key_t)i;
      return 0;
    }
  }
  return EAGAIN;
}

int pthread_key_delete(pthread_key_t key) {
  if (key >= CODEPOD_TLS_KEYS_MAX) return EINVAL;
  if (!tls_keys[key].in_use) return EINVAL;
  tls_keys[key].in_use     = 0;
  tls_keys[key].destructor = NULL;
  tls_keys[key].value      = NULL;
  return 0;
}

int pthread_setspecific(pthread_key_t key, const void *value) {
  CODEPOD_MARKER_CALL(pthread_setspecific);
  if (key >= CODEPOD_TLS_KEYS_MAX || !tls_keys[key].in_use) return EINVAL;
  tls_keys[key].value = (void *)value;
  return 0;
}

void *pthread_getspecific(pthread_key_t key) {
  CODEPOD_MARKER_CALL(pthread_getspecific);
  if (key >= CODEPOD_TLS_KEYS_MAX || !tls_keys[key].in_use) return NULL;
  return tls_keys[key].value;
}

/* ── pthread_once ─────────────────────────────────────────── */

int pthread_once(pthread_once_t *once_control, void (*init_routine)(void)) {
  CODEPOD_MARKER_CALL(pthread_once);
  if (!once_control || !init_routine) return EINVAL;
  /* wasi-libc's pthread_once_t is `int` — interpret zero as "not
   * yet run" (matches PTHREAD_ONCE_INIT's zero-init). */
  int *flag = (int *)once_control;
  if (!*flag) {
    init_routine();
    *flag = 1;
  }
  return 0;
}

/* ── Attribute getters/setters (accept-and-stash) ────────── */

/* attr storage is wasi-libc's union-of-ints — we treat the first
 * two int slots as our scratch space (detach-state and stacksize
 * for pthread_attr_t; type for pthread_mutexattr_t).  No fields
 * defined in pthread.h means we cast through (int *) here.
 * Future real-thread backends may interpret these slots differently
 * — the attr-setters are accept-and-stash; the *meaning* of the
 * stored value is honored only by backends that care. */

int pthread_attr_init(pthread_attr_t *attr) {
  if (!attr) return EINVAL;
  memset(attr, 0, sizeof(*attr));
  return 0;
}
int pthread_attr_destroy(pthread_attr_t *attr) {
  if (!attr) return EINVAL;
  return 0;
}
int pthread_attr_getdetachstate(const pthread_attr_t *attr, int *detachstate) {
  if (!attr || !detachstate) return EINVAL;
  *detachstate = ((const int *)attr)[0] & 1;
  return 0;
}
int pthread_attr_setdetachstate(pthread_attr_t *attr, int detachstate) {
  if (!attr) return EINVAL;
  if (detachstate != PTHREAD_CREATE_JOINABLE &&
      detachstate != PTHREAD_CREATE_DETACHED) return EINVAL;
  int *slots = (int *)attr;
  slots[0] = (slots[0] & ~1) | (detachstate & 1);
  return 0;
}
int pthread_attr_getstacksize(const pthread_attr_t *attr, size_t *stacksize) {
  if (!attr || !stacksize) return EINVAL;
  *stacksize = (size_t)((const unsigned int *)attr)[1];
  return 0;
}
int pthread_attr_setstacksize(pthread_attr_t *attr, size_t stacksize) {
  if (!attr) return EINVAL;
  ((unsigned int *)attr)[1] = (unsigned int)stacksize;
  return 0;
}

int pthread_mutexattr_init(pthread_mutexattr_t *attr) {
  if (!attr) return EINVAL;
  memset(attr, 0, sizeof(*attr));
  return 0;
}
int pthread_mutexattr_destroy(pthread_mutexattr_t *attr) {
  if (!attr) return EINVAL;
  return 0;
}
int pthread_mutexattr_settype(pthread_mutexattr_t *attr, int type) {
  if (!attr) return EINVAL;
  if (type < 0 || type > PTHREAD_MUTEX_ERRORCHECK) return EINVAL;
  ((int *)attr)[0] = type;
  return 0;
}
int pthread_mutexattr_gettype(const pthread_mutexattr_t *attr, int *type) {
  if (!attr || !type) return EINVAL;
  *type = ((const int *)attr)[0];
  return 0;
}

int pthread_condattr_init(pthread_condattr_t *attr) {
  if (!attr) return EINVAL;
  memset(attr, 0, sizeof(*attr));
  return 0;
}
int pthread_condattr_destroy(pthread_condattr_t *attr) {
  if (!attr) return EINVAL;
  return 0;
}

/* ── Cancellation ───────────────────────────────────────────── */

int pthread_cancel(pthread_t thread) {
  (void)thread;
  errno = ENOTSUP;
  return ENOTSUP;
}
int pthread_setcancelstate(int state, int *oldstate) {
  if (state != PTHREAD_CANCEL_ENABLE && state != PTHREAD_CANCEL_DISABLE)
    return EINVAL;
  if (oldstate) *oldstate = PTHREAD_CANCEL_DISABLE;
  return 0;
}
int pthread_setcanceltype(int type, int *oldtype) {
  if (type != PTHREAD_CANCEL_DEFERRED && type != PTHREAD_CANCEL_ASYNCHRONOUS)
    return EINVAL;
  if (oldtype) *oldtype = PTHREAD_CANCEL_DEFERRED;
  return 0;
}
void pthread_testcancel(void) {
  /* No async cancellation source under cooperative-serial. */
}
