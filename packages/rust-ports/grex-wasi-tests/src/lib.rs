//! grex-wasi-tests — see Cargo.toml for rationale. Test code lives in
//! `tests/`, which `include!`s upstream grex's test files with the
//! upstream cfg gate stripped at build time.
//!
//! Each test file MUST reference `force_wasi_shims()` at least once so
//! that the `codepod-wasi-shims` rlib is pulled into the test binary's
//! link. Without an explicit reference, `--extern` dep resolution
//! drops the shim exports before `codepod-wasi-postlink` sees them.

use std::path::PathBuf;

/// Dead reference that forces the codepod-wasi-shims rlib into the
/// calling test binary's link. Invoked once (in an unused static
/// initializer) from each tests/*.rs file.
pub fn force_wasi_shims() -> PathBuf {
    codepod_wasi_shims::env_temp_dir()
}
