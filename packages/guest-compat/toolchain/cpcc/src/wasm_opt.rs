use crate::env::WasmOptMode;
use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Run wasm-opt on `path` in place, according to `mode`.
pub fn maybe_run(path: &Path, mode: &WasmOptMode) -> Result<()> {
    let args: Vec<std::ffi::OsString> = match mode {
        WasmOptMode::Disabled => return Ok(()),
        WasmOptMode::Default => vec![
            "-O2".into(),
            "--enable-bulk-memory".into(),
            "--enable-sign-ext".into(),
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
