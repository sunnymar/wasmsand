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
    "dup2",
    "getgroups",
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
];
