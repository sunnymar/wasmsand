use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types shared between trait and WASM host
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: u32,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone)]
pub enum HostError {
    NotFound(String),
    PermissionDenied(String),
    IoError(String),
    Other(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::PermissionDenied(msg) => write!(f, "permission denied: {msg}"),
            Self::IoError(msg) => write!(f, "I/O error: {msg}"),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelStatus {
    Running,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Truncate,
    Append,
}

// ---------------------------------------------------------------------------
// HostInterface trait — implemented by WasmHost (Task 2) or test stubs
// ---------------------------------------------------------------------------

pub trait HostInterface {
    fn spawn(
        &self,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
        stdin: &str,
    ) -> Result<SpawnResult, HostError>;

    fn has_tool(&self, name: &str) -> bool;

    fn check_cancel(&self) -> CancelStatus;

    fn time_ms(&self) -> u64;

    fn stat(&self, path: &str) -> Result<StatInfo, HostError>;

    fn read_file(&self, path: &str) -> Result<String, HostError>;

    fn write_file(&self, path: &str, data: &str, mode: WriteMode) -> Result<(), HostError>;

    fn readdir(&self, path: &str) -> Result<Vec<String>, HostError>;

    fn mkdir(&self, path: &str) -> Result<(), HostError>;

    fn remove(&self, path: &str, recursive: bool) -> Result<(), HostError>;

    fn chmod(&self, path: &str, mode: u32) -> Result<(), HostError>;

    fn glob(&self, pattern: &str) -> Result<Vec<String>, HostError>;

    fn rename(&self, from: &str, to: &str) -> Result<(), HostError>;

    fn symlink(&self, target: &str, link_path: &str) -> Result<(), HostError>;

    fn readlink(&self, path: &str) -> Result<String, HostError>;
}

// ---------------------------------------------------------------------------
// Raw WASM host imports (wasm32 only)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "codepod")]
extern "C" {
    /// Spawn a process on the host.
    /// `req_ptr`/`req_len` — pointer and length of a JSON-encoded spawn request.
    /// `out_ptr`/`out_cap` — pointer and capacity of a caller-allocated output buffer.
    /// Returns the number of bytes written to `out_ptr`, or a negative error code.
    pub fn host_spawn(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Check whether a named tool/binary is available.
    /// Returns 1 for true, 0 for false.
    pub fn host_has_tool(name_ptr: *const u8, name_len: u32) -> i32;

    /// Poll cancellation status.
    /// Returns 0 = running, 1 = cancelled, 2 = timed-out.
    pub fn host_check_cancel() -> i32;

    /// Get current wall-clock time in milliseconds.
    pub fn host_time_ms() -> u64;

    /// Stat a path.
    pub fn host_stat(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Read file contents.
    pub fn host_read_file(
        path_ptr: *const u8,
        path_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Write data to a file.
    /// `mode`: 0 = truncate, 1 = append.
    pub fn host_write_file(
        path_ptr: *const u8,
        path_len: u32,
        data_ptr: *const u8,
        data_len: u32,
        mode: u32,
    ) -> i32;

    /// List directory entries (JSON array of strings).
    pub fn host_readdir(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Create a directory (and parents).
    pub fn host_mkdir(path_ptr: *const u8, path_len: u32) -> i32;

    /// Remove a path. `recursive`: 0 = single, 1 = recursive.
    pub fn host_remove(path_ptr: *const u8, path_len: u32, recursive: u32) -> i32;

    /// Set file mode bits.
    pub fn host_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;

    /// Glob pattern match (JSON array of matching paths).
    pub fn host_glob(
        pattern_ptr: *const u8,
        pattern_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Rename / move a path.
    pub fn host_rename(from_ptr: *const u8, from_len: u32, to_ptr: *const u8, to_len: u32) -> i32;

    /// Create a symbolic link.
    pub fn host_symlink(
        target_ptr: *const u8,
        target_len: u32,
        link_ptr: *const u8,
        link_len: u32,
    ) -> i32;

    /// Read symbolic link target.
    pub fn host_readlink(path_ptr: *const u8, path_len: u32, out_ptr: *mut u8, out_cap: u32)
        -> i32;
}

// ---------------------------------------------------------------------------
// Helper: call a host function that writes into an output buffer
// ---------------------------------------------------------------------------

/// Call a host FFI function that follows the pattern:
///   fn(args..., out_ptr, out_cap) -> i32
/// where a negative return is an error code and a positive return is the
/// number of bytes written.  Returns the output as a `String`.
#[cfg(target_arch = "wasm32")]
pub fn call_with_outbuf<F>(initial_cap: usize, f: F) -> Result<String, HostError>
where
    F: Fn(*mut u8, u32) -> i32,
{
    let mut buf: Vec<u8> = vec![0u8; initial_cap];
    let n = f(buf.as_mut_ptr(), buf.len() as u32);
    if n < 0 {
        return Err(HostError::Other(format!(
            "host call returned error code {n}"
        )));
    }
    let n = n as usize;
    if n > buf.len() {
        // Host indicated it needs more space; retry with the returned size.
        buf.resize(n, 0);
        let n2 = f(buf.as_mut_ptr(), buf.len() as u32);
        if n2 < 0 {
            return Err(HostError::Other(format!(
                "host call returned error code {n2} on retry"
            )));
        }
        buf.truncate(n2 as usize);
    } else {
        buf.truncate(n);
    }
    String::from_utf8(buf).map_err(|e| HostError::Other(format!("invalid UTF-8 from host: {e}")))
}
