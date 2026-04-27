#ifndef CODEPOD_COMPAT_PTHREAD_H
#define CODEPOD_COMPAT_PTHREAD_H

/* POSIX pthread Tier 1 surface for codepod's guest-compat runtime.
 *
 * Real concurrency is a backend property — see
 * docs/superpowers/specs/2026-04-27-wasi-threads-design.md for the
 * full design.  Step 1 (this header + libcodepod_guest_compat.a) is
 * the *cooperative* path: pthread_create runs start_routine inline,
 * pthread_join returns its stored result, mutex/cond are no-ops.
 * Code that compiles + links against pthread.h here is portable to
 * the wasi-threads flavor (Step 3+) where the same symbols deliver
 * real parallelism on wasmtime + browser/SAB.
 *
 * Out-of-contract under Step 1's cooperative scheduler:
 *   - Rayon-style "main spawns workers blocked on cond, dispatches
 *     work, joins" — the workers never reach cond_wait because they
 *     run to completion synchronously inside pthread_create.  Such
 *     workloads need the threads-flavor binary (later step).
 *   - pthread_cancel — returns ENOTSUP (cancellation semantics are
 *     too entangled with cooperative-vs-preemptive to stub safely).
 *   - Process-shared mutexes (PTHREAD_PROCESS_SHARED) — ENOTSUP.
 */

#include <sched.h>
#include <stddef.h>
#include <time.h>

/* Opaque pthread types are pulled from wasi-libc's
 * <bits/alltypes.h> via these __NEED_* triggers.  Going through
 * the platform headers (rather than redeclaring) avoids the
 * typedef-redefinition trap when guest code includes both
 * <sys/types.h> and <pthread.h>.  wasi-libc sizes pthread_mutex_t
 * / pthread_cond_t at 40 bytes each — plenty of room for the
 * future real-thread backends to stash atomic state. */
#define __NEED_pthread_t
#define __NEED_pthread_mutex_t
#define __NEED_pthread_mutexattr_t
#define __NEED_pthread_cond_t
#define __NEED_pthread_condattr_t
#define __NEED_pthread_rwlock_t
#define __NEED_pthread_rwlockattr_t
#define __NEED_pthread_attr_t
#define __NEED_pthread_key_t
#define __NEED_pthread_once_t
#define __NEED_pthread_spinlock_t
#define __NEED_pthread_barrier_t
#define __NEED_pthread_barrierattr_t
#include <bits/alltypes.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Initializers ─────────────────────────────────────────────────
 *
 * wasi-libc's pthread_mutex_t / pthread_cond_t are zero-init
 * compatible (the type is a union of int arrays + ptr arrays, all
 * of which are zero-valid).  PTHREAD_MUTEX_INITIALIZER expands to
 * a zero-initializer; the backend interprets a zero state as
 * "untaken".  Same for cond / rwlock. */

#define PTHREAD_ONCE_INIT             { 0 }
#define PTHREAD_MUTEX_INITIALIZER     { { { 0 } } }
#define PTHREAD_COND_INITIALIZER      { { { 0 } } }
#define PTHREAD_RWLOCK_INITIALIZER    { { { 0 } } }

/* Mutex types — codepod accepts these but the cooperative impl
 * doesn't actually distinguish them (no contention possible). */
#define PTHREAD_MUTEX_NORMAL          0
#define PTHREAD_MUTEX_RECURSIVE       1
#define PTHREAD_MUTEX_ERRORCHECK      2
#define PTHREAD_MUTEX_DEFAULT         PTHREAD_MUTEX_NORMAL

/* Detach state. */
#define PTHREAD_CREATE_JOINABLE       0
#define PTHREAD_CREATE_DETACHED       1

/* Process scope (only PROCESS_PRIVATE is supported under codepod —
 * single-process sandbox has no SHARED case). */
#define PTHREAD_PROCESS_PRIVATE       0
#define PTHREAD_PROCESS_SHARED        1

/* ── Tier 1 ───────────────────────────────────────────────────── */

/* Thread lifecycle.  Real impls in libcodepod_guest_compat.a
 * (codepod_pthread.c).  Step 1 cooperative semantics: pthread_create
 * runs start_routine(arg) synchronously, stores the return value;
 * pthread_join hands it back and frees the slot.  pthread_detach
 * marks the slot for auto-free at thread completion (a no-op in
 * Step 1 since completion happens inside pthread_create itself). */
int      pthread_create(pthread_t *thread,
                        const pthread_attr_t *attr,
                        void *(*start_routine)(void *),
                        void *arg);
int      pthread_join(pthread_t thread, void **retval);
int      pthread_detach(pthread_t thread);
void     pthread_exit(void *retval) __attribute__((noreturn));
pthread_t pthread_self(void);
int      pthread_equal(pthread_t a, pthread_t b);

/* Mutex.  Cooperative impl: lock/unlock are no-ops returning 0
 * (no contention possible since execution is single-threaded);
 * trylock always succeeds.  Layout-compatible with the future
 * real-thread impl. */
int      pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr);
int      pthread_mutex_destroy(pthread_mutex_t *mutex);
int      pthread_mutex_lock(pthread_mutex_t *mutex);
int      pthread_mutex_unlock(pthread_mutex_t *mutex);
int      pthread_mutex_trylock(pthread_mutex_t *mutex);

/* Condition variable.  Cooperative impl: wait/signal/broadcast all
 * return 0 with no actual blocking (no waiters can exist since
 * execution is single-threaded). */
int      pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr);
int      pthread_cond_destroy(pthread_cond_t *cond);
int      pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex);
int      pthread_cond_timedwait(pthread_cond_t *cond,
                                pthread_mutex_t *mutex,
                                const struct timespec *abstime);
int      pthread_cond_signal(pthread_cond_t *cond);
int      pthread_cond_broadcast(pthread_cond_t *cond);

/* Thread-local storage.  pthread_key_create allocates a key (0..N);
 * pthread_setspecific/getspecific keep per-thread values in a
 * compat-side map indexed by (current_thread_id, key).  The
 * destructor is invoked when a thread terminates. */
int      pthread_key_create(pthread_key_t *key, void (*destructor)(void *));
int      pthread_key_delete(pthread_key_t key);
int      pthread_setspecific(pthread_key_t key, const void *value);
void *   pthread_getspecific(pthread_key_t key);

/* pthread_once — runs init_routine exactly once across all threads
 * that share `once_control`.  Cooperative impl uses a simple flag. */
int      pthread_once(pthread_once_t *once_control, void (*init_routine)(void));

/* Attribute setters/getters (Tier 1 subset — most flags are
 * accepted-and-ignored under cooperative scheduling). */
int      pthread_attr_init(pthread_attr_t *attr);
int      pthread_attr_destroy(pthread_attr_t *attr);
int      pthread_attr_getdetachstate(const pthread_attr_t *attr, int *detachstate);
int      pthread_attr_setdetachstate(pthread_attr_t *attr, int detachstate);
int      pthread_attr_getstacksize(const pthread_attr_t *attr, size_t *stacksize);
int      pthread_attr_setstacksize(pthread_attr_t *attr, size_t stacksize);

int      pthread_mutexattr_init(pthread_mutexattr_t *attr);
int      pthread_mutexattr_destroy(pthread_mutexattr_t *attr);
int      pthread_mutexattr_settype(pthread_mutexattr_t *attr, int type);
int      pthread_mutexattr_gettype(const pthread_mutexattr_t *attr, int *type);

int      pthread_condattr_init(pthread_condattr_t *attr);
int      pthread_condattr_destroy(pthread_condattr_t *attr);

/* Cancellation — codepod returns ENOTSUP from pthread_cancel since
 * the semantics don't fit a cooperative scheduler.  setcancelstate
 * / setcanceltype accept-and-stash so guest code that *configures*
 * cancellation without actually cancelling links cleanly. */
#define PTHREAD_CANCEL_ENABLE         0
#define PTHREAD_CANCEL_DISABLE        1
#define PTHREAD_CANCEL_DEFERRED       0
#define PTHREAD_CANCEL_ASYNCHRONOUS   1
#define PTHREAD_CANCELED              ((void *) -1)

int      pthread_cancel(pthread_t thread);
int      pthread_setcancelstate(int state, int *oldstate);
int      pthread_setcanceltype(int type, int *oldtype);
void     pthread_testcancel(void);

#ifdef __cplusplus
}
#endif

#endif /* CODEPOD_COMPAT_PTHREAD_H */
