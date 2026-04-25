use crate::env::WasmOptMode;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Run wasm-opt on `path` in place, according to `mode`.
///
/// The Default mode applies optimizations first (-O2) and then runs
/// the Asyncify pass — order matters: Asyncify instruments every
/// function with the state-machine guards needed for unwind/rewind,
/// and downstream optimization passes that re-shape control flow
/// would invalidate those guards.  Running Asyncify last preserves
/// the invariants the runtime relies on.
///
/// Asyncify is unconditional in Default mode because it's the
/// universal mechanism for cooperative scheduling in codepod —
/// async host imports already use it as a fallback when JSPI is
/// unavailable, and POSIX setjmp/longjmp ride the same machinery
/// (setjmp captures the asyncify save-state, longjmp triggers an
/// unwind+rewind back to the matching setjmp call).  The runtime
/// drives the unwind/rewind loop uniformly for every guest wasm.
pub fn maybe_run(path: &Path, mode: &WasmOptMode) -> Result<()> {
    let args: Vec<std::ffi::OsString> = match mode {
        WasmOptMode::Disabled => return Ok(()),
        WasmOptMode::Default => vec![
            "-O2".into(),
            "--enable-bulk-memory".into(),
            "--enable-sign-ext".into(),
            "--asyncify".into(),
        ],
        WasmOptMode::Explicit(v) => v.clone(),
    };
    let wasm_opt = which::which("wasm-opt")
        .map_err(|_| anyhow!("wasm-opt requested but not on PATH (CPCC_NO_WASM_OPT=1 to skip)"))?;
    let status = Command::new(wasm_opt)
        .args(&args)
        .arg(path)
        .arg("-o")
        .arg(path)
        .status()
        .with_context(|| format!("running wasm-opt on {}", path.display()))?;
    if !status.success() {
        return Err(anyhow!("wasm-opt failed on {}", path.display()));
    }
    Ok(())
}
