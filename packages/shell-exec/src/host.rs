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
pub struct FetchResult {
    pub ok: bool,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub error: Option<String>,
}

/// JSON-encoded spawn request sent to the host via `host_spawn`.
#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
struct SpawnRequest<'a> {
    program: &'a str,
    args: &'a [&'a str],
    env: &'a [(&'a str, &'a str)],
    cwd: &'a str,
    stdin: &'a str,
}

/// JSON-encoded fetch request sent to the host via `host_fetch`.
#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
struct FetchRequest<'a> {
    url: &'a str,
    method: &'a str,
    headers: &'a [(&'a str, &'a str)],
    body: Option<&'a str>,
}

/// JSON-encoded extension invoke request sent to the host via `host_extension_invoke`.
#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
struct ExtensionInvokeRequest<'a> {
    name: &'a str,
    args: &'a [&'a str],
    stdin: &'a str,
    env: &'a [(&'a str, &'a str)],
    cwd: &'a str,
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
            Self::NotFound(msg) => write!(f, "{msg}: No such file or directory"),
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

    /// Perform an HTTP fetch via the host. All arg parsing and response
    /// formatting happens in Rust; only the actual I/O crosses to the host.
    fn fetch(
        &self,
        url: &str,
        method: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> FetchResult;

    /// Invoke a host extension command. The extension handler is an async JS
    /// closure; JSPI handles the WASM suspend/resume transparently.
    fn extension_invoke(
        &self,
        name: &str,
        args: &[&str],
        stdin: &str,
        env: &[(&str, &str)],
        cwd: &str,
    ) -> Result<SpawnResult, HostError>;

    /// Register a pkg-installed tool with the host process manager.
    fn register_tool(&self, name: &str, wasm_path: &str) -> Result<(), HostError>;

    /// Check whether a command name is a registered host extension.
    fn is_extension(&self, name: &str) -> bool;

    // ----- Process management (Task 5) -----

    /// Create a pipe, returning `(read_fd, write_fd)`.
    fn pipe(&self) -> Result<(i32, i32), HostError>;

    /// Spawn a child process asynchronously (returns immediately with pid).
    /// The caller is responsible for wiring up stdin/stdout/stderr via
    /// file descriptors obtained from `pipe()`.
    #[allow(clippy::too_many_arguments)]
    fn spawn_async(
        &self,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
        stdin_fd: i32,
        stdout_fd: i32,
        stderr_fd: i32,
    ) -> Result<i32, HostError>;

    /// Wait for a child process to exit (blocking). Returns the exit code.
    fn waitpid(&self, pid: i32) -> Result<i32, HostError>;

    /// Close a host-side file descriptor.
    fn close_fd(&self, fd: i32) -> Result<(), HostError>;

    /// Yield to the scheduler (cooperative scheduling: sleep(0)).
    fn yield_now(&self) -> Result<(), HostError>;
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

    /// Perform an HTTP fetch. JSON request/response via output buffer.
    pub fn host_fetch(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Invoke a host extension command. JSON request/response via output buffer.
    /// Returns a Promise on the host side; JSPI suspends/resumes WASM transparently.
    pub fn host_extension_invoke(
        req_ptr: *const u8,
        req_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Register a pkg-installed tool with the host.
    pub fn host_register_tool(
        name_ptr: *const u8,
        name_len: u32,
        path_ptr: *const u8,
        path_len: u32,
    ) -> i32;

    /// Check whether a command is a registered host extension. Returns 1 for true, 0 for false.
    pub fn host_is_extension(name_ptr: *const u8, name_len: u32) -> i32;

    /// Read the next command from the host session loop.
    pub fn host_read_command(out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Write a JSON-encoded RunResult back to the host.
    pub fn host_write_result(data_ptr: *const u8, data_len: u32);

    // ----- Process management syscalls (Task 5) -----

    /// Create a pipe. Writes JSON `{"read_fd": N, "write_fd": M}` into the
    /// output buffer. Returns bytes written, or negative error code.
    fn host_pipe(out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Spawn a child process asynchronously (does NOT wait for exit).
    /// `req_ptr`/`req_len` — JSON-encoded spawn request with prog, args, env,
    /// cwd, stdin_fd, stdout_fd, stderr_fd.
    /// Returns the child PID (>= 0) or a negative error code.
    fn host_spawn_async(req_ptr: *const u8, req_len: u32) -> i32;

    /// Wait for a child process to exit (BLOCKING — JSPI suspends the WASM
    /// stack while the host awaits the child).
    /// Writes JSON `{"exit_code": N}` into the output buffer.
    /// Returns bytes written, or negative error code.
    fn host_waitpid(pid: i32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Close a host-side file descriptor. Returns 0 on success, negative on error.
    fn host_close_fd(fd: i32) -> i32;

    /// Yield to the JS microtask queue (cooperative scheduling: sleep(0)).
    /// JSPI-suspending — allows other WASM stacks to run.
    fn host_yield();
}

// ---------------------------------------------------------------------------
// Error-code helper
// ---------------------------------------------------------------------------

/// Convert a negative host return code to a typed `HostError`.
///
/// Convention: -1 = NotFound, -2 = PermissionDenied, -3 = IoError.
#[cfg(target_arch = "wasm32")]
fn rc_to_error(rc: i32, context: &str) -> HostError {
    match rc {
        -1 => HostError::NotFound(context.into()),
        -2 => HostError::PermissionDenied(context.into()),
        -3 => HostError::IoError(context.into()),
        other => HostError::Other(format!("{context}: host error code {other}")),
    }
}

// ---------------------------------------------------------------------------
// Helper: call a host function that writes into an output buffer
// ---------------------------------------------------------------------------

/// Default starting capacity for output buffers.
#[cfg(target_arch = "wasm32")]
const DEFAULT_OUTBUF_CAP: usize = 4096;

/// Call a host FFI function that follows the pattern:
///   fn(args..., out_ptr, out_cap) -> i32
/// where a negative return is an error code and a positive return is the
/// number of bytes written.  Returns the output as a `String`.
///
/// `context` is used to produce meaningful error messages (typically the
/// path or operation name).
#[cfg(target_arch = "wasm32")]
fn call_with_outbuf<F>(context: &str, f: F) -> Result<String, HostError>
where
    F: Fn(*mut u8, u32) -> i32,
{
    let mut buf: Vec<u8> = vec![0u8; DEFAULT_OUTBUF_CAP];
    let n = f(buf.as_mut_ptr(), buf.len() as u32);
    if n < 0 {
        return Err(rc_to_error(n, context));
    }
    let n = n as usize;
    if n > buf.len() {
        // Host indicated it needs more space; retry with the returned size.
        buf.resize(n, 0);
        let n2 = f(buf.as_mut_ptr(), buf.len() as u32);
        if n2 < 0 {
            return Err(rc_to_error(n2, context));
        }
        buf.truncate(n2 as usize);
    } else {
        buf.truncate(n);
    }
    String::from_utf8(buf).map_err(|e| HostError::Other(format!("invalid UTF-8 from host: {e}")))
}

// ---------------------------------------------------------------------------
// WasmHost — production HostInterface bridge (wasm32 only)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
pub struct WasmHost;

#[cfg(target_arch = "wasm32")]
impl HostInterface for WasmHost {
    fn spawn(
        &self,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
        stdin: &str,
    ) -> Result<SpawnResult, HostError> {
        let req = SpawnRequest {
            program,
            args,
            env,
            cwd,
            stdin,
        };
        let req_json = serde_json::to_vec(&req)
            .map_err(|e| HostError::Other(format!("spawn: failed to serialize request: {e}")))?;
        let output = call_with_outbuf("spawn", |out_ptr, out_cap| unsafe {
            host_spawn(req_json.as_ptr(), req_json.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output)
            .map_err(|e| HostError::Other(format!("spawn: failed to deserialize response: {e}")))
    }

    fn has_tool(&self, name: &str) -> bool {
        unsafe { host_has_tool(name.as_ptr(), name.len() as u32) != 0 }
    }

    fn check_cancel(&self) -> CancelStatus {
        match unsafe { host_check_cancel() } {
            1 => CancelStatus::Cancelled,
            2 => CancelStatus::TimedOut,
            _ => CancelStatus::Running,
        }
    }

    fn time_ms(&self) -> u64 {
        unsafe { host_time_ms() }
    }

    fn stat(&self, path: &str) -> Result<StatInfo, HostError> {
        let output = call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_stat(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output).map_err(|e| HostError::IoError(format!("stat {path}: {e}")))
    }

    fn read_file(&self, path: &str) -> Result<String, HostError> {
        call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_read_file(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })
    }

    fn write_file(&self, path: &str, data: &str, mode: WriteMode) -> Result<(), HostError> {
        let mode_u32 = match mode {
            WriteMode::Truncate => 0,
            WriteMode::Append => 1,
        };
        let rc = unsafe {
            host_write_file(
                path.as_ptr(),
                path.len() as u32,
                data.as_ptr(),
                data.len() as u32,
                mode_u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn readdir(&self, path: &str) -> Result<Vec<String>, HostError> {
        let output = call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_readdir(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output)
            .map_err(|e| HostError::IoError(format!("readdir {path}: {e}")))
    }

    fn mkdir(&self, path: &str) -> Result<(), HostError> {
        let rc = unsafe { host_mkdir(path.as_ptr(), path.len() as u32) };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn remove(&self, path: &str, recursive: bool) -> Result<(), HostError> {
        let rc = unsafe {
            host_remove(
                path.as_ptr(),
                path.len() as u32,
                if recursive { 1 } else { 0 },
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn chmod(&self, path: &str, mode: u32) -> Result<(), HostError> {
        let rc = unsafe { host_chmod(path.as_ptr(), path.len() as u32, mode) };
        if rc < 0 {
            Err(rc_to_error(rc, path))
        } else {
            Ok(())
        }
    }

    fn glob(&self, pattern: &str) -> Result<Vec<String>, HostError> {
        let output = call_with_outbuf(pattern, |out_ptr, out_cap| unsafe {
            host_glob(pattern.as_ptr(), pattern.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output)
            .map_err(|e| HostError::IoError(format!("glob {pattern}: {e}")))
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), HostError> {
        let rc = unsafe {
            host_rename(
                from.as_ptr(),
                from.len() as u32,
                to.as_ptr(),
                to.len() as u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, from))
        } else {
            Ok(())
        }
    }

    fn symlink(&self, target: &str, link_path: &str) -> Result<(), HostError> {
        let rc = unsafe {
            host_symlink(
                target.as_ptr(),
                target.len() as u32,
                link_path.as_ptr(),
                link_path.len() as u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, link_path))
        } else {
            Ok(())
        }
    }

    fn readlink(&self, path: &str) -> Result<String, HostError> {
        call_with_outbuf(path, |out_ptr, out_cap| unsafe {
            host_readlink(path.as_ptr(), path.len() as u32, out_ptr, out_cap)
        })
    }

    fn fetch(
        &self,
        url: &str,
        method: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> FetchResult {
        let req = FetchRequest {
            url,
            method,
            headers,
            body,
        };
        let req_json = match serde_json::to_vec(&req) {
            Ok(j) => j,
            Err(e) => {
                return FetchResult {
                    ok: false,
                    status: 0,
                    headers: vec![],
                    body: String::new(),
                    error: Some(format!("fetch: failed to serialize request: {e}")),
                }
            }
        };
        let output = call_with_outbuf("fetch", |out_ptr, out_cap| unsafe {
            host_fetch(req_json.as_ptr(), req_json.len() as u32, out_ptr, out_cap)
        });
        match output {
            Ok(json) => serde_json::from_str(&json).unwrap_or_else(|e| FetchResult {
                ok: false,
                status: 0,
                headers: vec![],
                body: String::new(),
                error: Some(format!("fetch: failed to deserialize response: {e}")),
            }),
            Err(e) => FetchResult {
                ok: false,
                status: 0,
                headers: vec![],
                body: String::new(),
                error: Some(format!("fetch: host error: {e}")),
            },
        }
    }

    fn extension_invoke(
        &self,
        name: &str,
        args: &[&str],
        stdin: &str,
        env: &[(&str, &str)],
        cwd: &str,
    ) -> Result<SpawnResult, HostError> {
        let req = ExtensionInvokeRequest {
            name,
            args,
            stdin,
            env,
            cwd,
        };
        let req_json = serde_json::to_vec(&req)
            .map_err(|e| HostError::Other(format!("extension_invoke: failed to serialize: {e}")))?;
        let output = call_with_outbuf("extension_invoke", |out_ptr, out_cap| unsafe {
            host_extension_invoke(req_json.as_ptr(), req_json.len() as u32, out_ptr, out_cap)
        })?;
        serde_json::from_str(&output)
            .map_err(|e| HostError::Other(format!("extension_invoke: failed to deserialize: {e}")))
    }

    fn register_tool(&self, name: &str, wasm_path: &str) -> Result<(), HostError> {
        let rc = unsafe {
            host_register_tool(
                name.as_ptr(),
                name.len() as u32,
                wasm_path.as_ptr(),
                wasm_path.len() as u32,
            )
        };
        if rc < 0 {
            Err(rc_to_error(rc, name))
        } else {
            Ok(())
        }
    }

    fn is_extension(&self, name: &str) -> bool {
        unsafe { host_is_extension(name.as_ptr(), name.len() as u32) != 0 }
    }

    // ----- Process management (Task 5) -----

    fn pipe(&self) -> Result<(i32, i32), HostError> {
        let result_json = call_with_outbuf("pipe", |out_ptr, out_cap| unsafe {
            host_pipe(out_ptr, out_cap)
        })?;
        let parsed: serde_json::Value = serde_json::from_str(&result_json)
            .map_err(|e| HostError::IoError(format!("pipe: {e}")))?;
        let read_fd = parsed["read_fd"].as_i64().unwrap_or(-1) as i32;
        let write_fd = parsed["write_fd"].as_i64().unwrap_or(-1) as i32;
        Ok((read_fd, write_fd))
    }

    fn spawn_async(
        &self,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &str,
        stdin_fd: i32,
        stdout_fd: i32,
        stderr_fd: i32,
    ) -> Result<i32, HostError> {
        let req = serde_json::json!({
            "prog": program,
            "args": args,
            "env": env,
            "cwd": cwd,
            "stdin_fd": stdin_fd,
            "stdout_fd": stdout_fd,
            "stderr_fd": stderr_fd,
        });
        let req_bytes = req.to_string();
        let pid = unsafe { host_spawn_async(req_bytes.as_ptr(), req_bytes.len() as u32) };
        if pid < 0 {
            return Err(HostError::IoError(format!(
                "spawn_async({}): host error code {}",
                program, pid
            )));
        }
        Ok(pid)
    }

    fn waitpid(&self, pid: i32) -> Result<i32, HostError> {
        let result_json = call_with_outbuf("waitpid", |out_ptr, out_cap| unsafe {
            host_waitpid(pid, out_ptr, out_cap)
        })?;
        let parsed: serde_json::Value = serde_json::from_str(&result_json)
            .map_err(|e| HostError::IoError(format!("waitpid: {e}")))?;
        Ok(parsed["exit_code"].as_i64().unwrap_or(-1) as i32)
    }

    fn close_fd(&self, fd: i32) -> Result<(), HostError> {
        let rc = unsafe { host_close_fd(fd) };
        if rc < 0 {
            return Err(HostError::IoError(format!(
                "close_fd({}): host error code {}",
                fd, rc
            )));
        }
        Ok(())
    }

    fn yield_now(&self) -> Result<(), HostError> {
        unsafe { host_yield() };
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Session functions (wasm32 only) — not on the trait
// ---------------------------------------------------------------------------

/// Read the next command string from the host session loop.
#[cfg(target_arch = "wasm32")]
pub fn read_command() -> String {
    call_with_outbuf("read_command", |ptr, cap| unsafe {
        host_read_command(ptr, cap)
    })
    .unwrap_or_default()
}

/// Write a `RunResult` back to the host as JSON.
#[cfg(target_arch = "wasm32")]
pub fn write_result(result: &crate::control::RunResult) {
    let json = serde_json::to_vec(result).unwrap();
    unsafe { host_write_result(json.as_ptr(), json.len() as u32) };
}

// ---------------------------------------------------------------------------
// WASI P1 fd I/O wrappers (wasm32 only) — used by builtins for direct fd I/O
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn fd_write(fd: i32, iovs: *const WasiIovec, iovs_len: u32, nwritten: *mut u32) -> u32;
    fn fd_read(fd: i32, iovs: *const WasiIovec, iovs_len: u32, nread: *mut u32) -> u32;
}

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct WasiIovec {
    buf: *const u8,
    buf_len: u32,
}

/// Write `data` to a host file descriptor via WASI `fd_write`.
#[cfg(target_arch = "wasm32")]
pub fn write_to_fd(fd: i32, data: &[u8]) -> Result<usize, HostError> {
    let iov = WasiIovec {
        buf: data.as_ptr(),
        buf_len: data.len() as u32,
    };
    let mut nwritten: u32 = 0;
    let errno = unsafe { fd_write(fd, &iov, 1, &mut nwritten) };
    if errno != 0 {
        return Err(HostError::IoError(format!("fd_write errno {}", errno)));
    }
    Ok(nwritten as usize)
}

/// Read from a host file descriptor via WASI `fd_read`.
#[cfg(target_arch = "wasm32")]
pub fn read_from_fd(fd: i32, buf: &mut [u8]) -> Result<usize, HostError> {
    let iov = WasiIovec {
        buf: buf.as_mut_ptr(),
        buf_len: buf.len() as u32,
    };
    let mut nread: u32 = 0;
    let errno = unsafe { fd_read(fd, &iov, 1, &mut nread) };
    if errno != 0 {
        return Err(HostError::IoError(format!("fd_read errno {}", errno)));
    }
    Ok(nread as usize)
}
