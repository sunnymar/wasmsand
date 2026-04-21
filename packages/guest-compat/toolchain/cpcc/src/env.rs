use std::ffi::OsString;
use std::path::PathBuf;

/// User-facing environment variables (§Toolchain Integration — the
/// CPCC_* surface).
pub struct Env {
    pub archive: Option<PathBuf>,
    pub include: Option<PathBuf>,
    pub skip_version_check: bool,
    // Used by Task 8 (wasm-opt invocation).
    #[allow(dead_code)]
    pub preserve_pre_opt: Option<PathBuf>,
    // Used by Task 8 (wasm-opt invocation).
    #[allow(dead_code)]
    pub wasm_opt: WasmOptMode,
}

pub enum WasmOptMode {
    Disabled,
    Default,
    #[allow(dead_code)]
    Explicit(Vec<OsString>),
}

impl Env {
    pub fn from_process() -> Self {
        Self {
            archive: std::env::var_os("CPCC_ARCHIVE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            include: std::env::var_os("CPCC_INCLUDE")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            skip_version_check: std::env::var_os("CPCC_SKIP_VERSION_CHECK").is_some(),
            preserve_pre_opt: std::env::var_os("CPCC_PRESERVE_PRE_OPT").map(PathBuf::from),
            wasm_opt: if std::env::var_os("CPCC_NO_WASM_OPT").is_some() {
                WasmOptMode::Disabled
            } else if let Some(flags) = std::env::var_os("CPCC_WASM_OPT_FLAGS") {
                let s = flags.to_string_lossy().to_string();
                WasmOptMode::Explicit(s.split_whitespace().map(OsString::from).collect())
            } else {
                WasmOptMode::Default
            },
        }
    }
}
