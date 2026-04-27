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
];
