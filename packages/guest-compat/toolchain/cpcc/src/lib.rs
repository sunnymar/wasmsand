pub mod archive;
pub mod cargo_codepod;
pub mod conform;
pub mod env;
pub mod precheck;
pub mod preserve;
pub mod spec;
pub mod trace;
pub mod wasi_sdk;
pub mod wasm_opt;

/// Tier 1 symbols from §Compatibility Tiers. Consumed by `cpcc` (to
/// force-export each symbol + its marker at link time) and `cpcheck`
/// (as the default list for §Verifying Precedence).
pub const TIER1: &[&str] = &[
    "chown",
    "chroot",
    "flockfile",
    "ftrylockfile",
    "funlockfile",
    "qsort_r",
    "setresgid",
    "setresuid",
    "dup",
    "dup2",
    "dup3",
    "execv",
    "execve",
    "execvp",
    "fchdir",
    "fchown",
    "fork",
    "vfork",
    "getgroups",
    "getpriority",
    "getrlimit",
    "getpgid",
    "getpgrp",
    "getsid",
    "lchown",
    "mkdtemp",
    "mkostemp",
    "mkstemp",
    "mktemp",
    "setpgid",
    "setpgrp",
    "setpriority",
    "setsid",
    "tcgetpgrp",
    "tcsetpgrp",
    "umask",
    "pipe",
    "pipe2",
    "posix_spawn",
    "posix_spawnp",
    "posix_spawn_file_actions_init",
    "posix_spawnattr_init",
    "setrlimit",
    "sched_getaffinity",
    "sched_setaffinity",
    "sched_getcpu",
    "signal",
    "sigaction",
    "raise",
    "alarm",
    "sigemptyset",
    "sigfillset",
    "sigaddset",
    "sigdelset",
    "sigismember",
    "sigprocmask",
    "sigsuspend",
    "tzset",
    "wait",
    "waitpid",
    // pthread Tier 1 — see
    // docs/superpowers/specs/2026-04-27-wasi-threads-design.md.
    // Backend-routed: the symbols thunk through codepod::host_*
    // imports; cpcheck (structural) verifies the .a archive
    // exports them and the linked binary doesn't fall back to
    // wasi-libc stubs.
    "pthread_create",
    "pthread_join",
    "pthread_detach",
    "pthread_exit",
    "pthread_self",
    "pthread_mutex_lock",
    "pthread_mutex_unlock",
    "pthread_cond_wait",
    "pthread_cond_signal",
    "pthread_key_create",
    "pthread_setspecific",
    "pthread_getspecific",
    "pthread_once",
];
