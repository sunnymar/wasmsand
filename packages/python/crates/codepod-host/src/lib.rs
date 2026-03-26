//! Native `_codepod` module for RustPython.
//!
//! Provides host-bridging functions that replace the magic FD protocol
//! (os.write to fd 1023/1022) with proper native function calls backed
//! by WASM host imports.
//!
//! Functions:
//! - `_codepod.fetch(method, url, headers=None, body=None)` -> dict
//! - `_codepod.extension_call(extension, method, **kwargs)` -> result
//! - `_codepod.extension_call(extension, method, **kwargs)` -> result (also checks existence)

use rustpython_vm as vm;
use vm::AsObject;

// ---------------------------------------------------------------------------
// WASM host imports — provided by the TypeScript host at instantiation time
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "codepod")]
extern "C" {
    /// Fetch a URL. Request is JSON, response is JSON.
    /// Returns bytes written to out_ptr, or negative error code.
    fn host_network_fetch(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Invoke a host extension method. Request is JSON, response is JSON.
    fn host_extension_invoke(
        req_ptr: *const u8,
        req_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32;

    /// Open a TCP/TLS socket. JSON request/response via output buffer.
    fn host_socket_connect(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32)
        -> i32;

    /// Send data on a socket. JSON request/response via output buffer.
    fn host_socket_send(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Receive data from a socket. JSON request/response via output buffer.
    fn host_socket_recv(req_ptr: *const u8, req_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;

    /// Close a socket. Returns 0 on success, negative on error.
    fn host_socket_close(req_ptr: *const u8, req_len: u32) -> i32;

    /// Invoke a method on a dynamically loaded native module WASM.
    /// module/method/args are passed separately (not wrapped in JSON).
    fn host_native_invoke(
        module_ptr: *const u8, module_len: u32,
        method_ptr: *const u8, method_len: u32,
        args_ptr: *const u8, args_len: u32,
        out_ptr: *mut u8, out_cap: u32,
    ) -> i32;
}

// ---------------------------------------------------------------------------
// Helper: call a host import with JSON request string, get JSON response string
// ---------------------------------------------------------------------------

/// Signature matching the host imports that take (req_ptr, req_len, out_ptr, out_cap) -> i32.
#[cfg(target_arch = "wasm32")]
type HostJsonFn = unsafe extern "C" fn(*const u8, u32, *mut u8, u32) -> i32;

#[cfg(target_arch = "wasm32")]
fn call_host_json(import_fn: HostJsonFn, request: &str) -> Result<String, String> {
    let req_bytes = request.as_bytes();
    let mut out_buf = vec![0u8; 65536]; // 64 KB initial buffer

    let rc = unsafe {
        import_fn(
            req_bytes.as_ptr(),
            req_bytes.len() as u32,
            out_buf.as_mut_ptr(),
            out_buf.len() as u32,
        )
    };

    if rc < 0 {
        return Err(format!("host call failed with error code {}", rc));
    }

    let len = rc as usize;
    if len > out_buf.len() {
        // Buffer too small — retry with a buffer large enough
        out_buf.resize(len, 0);
        let rc2 = unsafe {
            import_fn(
                req_bytes.as_ptr(),
                req_bytes.len() as u32,
                out_buf.as_mut_ptr(),
                out_buf.len() as u32,
            )
        };
        if rc2 < 0 {
            return Err(format!("host call failed on retry with error code {}", rc2));
        }
        out_buf.truncate(rc2 as usize);
    } else {
        out_buf.truncate(len);
    }

    String::from_utf8(out_buf).map_err(|e| format!("invalid UTF-8 in response: {}", e))
}

// ---------------------------------------------------------------------------
// JSON helpers — minimal manual builders to avoid serde dependency
// ---------------------------------------------------------------------------

/// Escape a string for inclusion in a JSON string literal.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// Convert a Python object to a JSON value string (best-effort).
/// Handles str, int, float, bool, None, list, and dict.
#[allow(deprecated)] // payload() usage
fn py_to_json(obj: &vm::PyObjectRef, py_vm: &vm::VirtualMachine) -> String {
    use vm::builtins::{PyDict, PyFloat, PyInt, PyList, PyStr};

    if py_vm.is_none(obj) {
        return "null".to_string();
    }
    // Check for bool singletons before PyInt (bool is a subclass of int)
    if obj.is(&py_vm.ctx.true_value) {
        return "true".to_string();
    }
    if obj.is(&py_vm.ctx.false_value) {
        return "false".to_string();
    }
    if let Some(i) = obj.payload::<PyInt>() {
        // Try i64 first for compact representation
        if let Ok(v) = i.try_to_primitive::<i64>(py_vm) {
            return v.to_string();
        }
        // Fall back to string repr
        return format!("\"{}\"", json_escape(&i.to_string()));
    }
    if let Some(f) = obj.payload::<PyFloat>() {
        return format!("{}", f.to_f64());
    }
    if let Some(s) = obj.payload::<PyStr>() {
        return format!("\"{}\"", json_escape(s.as_str()));
    }
    if let Some(list) = obj.payload::<PyList>() {
        let items: Vec<String> = list
            .borrow_vec()
            .iter()
            .map(|item| py_to_json(item, py_vm))
            .collect();
        return format!("[{}]", items.join(","));
    }
    if let Some(dict) = obj.payload::<PyDict>() {
        let mut parts = Vec::new();
        for (key, value) in dict.into_iter() {
            let key_str = if let Some(s) = key.payload::<PyStr>() {
                s.as_str().to_owned()
            } else {
                // Stringify non-string keys via Python __str__
                if let Ok(s) = key.str(py_vm) {
                    s.as_str().to_owned()
                } else {
                    "unknown".to_owned()
                }
            };
            parts.push(format!(
                "\"{}\":{}",
                json_escape(&key_str),
                py_to_json(&value, py_vm)
            ));
        }
        return format!("{{{}}}", parts.join(","));
    }
    // Fallback: stringify
    if let Ok(s) = obj.str(py_vm) {
        format!("\"{}\"", json_escape(s.as_str()))
    } else {
        "null".to_string()
    }
}

/// Parse a JSON response string into a Python object using the `json` stdlib module.
#[cfg(target_arch = "wasm32")]
fn json_to_py(json_str: &str, py_vm: &vm::VirtualMachine) -> vm::PyResult<vm::PyObjectRef> {
    // Import json module and call json.loads(json_str)
    let json_mod = py_vm.import("json", 0)?;
    let loads_fn = json_mod.get_attr("loads", py_vm)?;
    let py_str: vm::PyObjectRef = py_vm.ctx.new_str(json_str).into();
    loads_fn.call((py_str,), py_vm)
}

// ---------------------------------------------------------------------------
// Helpers for socket operations
// ---------------------------------------------------------------------------

/// Create an OSError exception.
fn os_err(py_vm: &vm::VirtualMachine, msg: &str) -> vm::PyRef<vm::builtins::PyBaseException> {
    py_vm.new_exception_msg(py_vm.ctx.exceptions.os_error.to_owned(), msg.to_owned())
}

/// Extract a string value from a JSON response by key (minimal parser).
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\":\"", key);
    let start = json.find(&pattern)? + pattern.len();
    let rest = &json[start..];
    let mut end = 0;
    let mut escaped = false;
    for ch in rest.chars() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            break;
        }
        end += ch.len_utf8();
    }
    Some(rest[..end].to_string())
}

/// Extract a numeric value from a JSON response by key (minimal parser).
fn extract_json_number(json: &str, key: &str) -> Option<i64> {
    let pattern = format!("\"{}\":", key);
    let start = json.find(&pattern)? + pattern.len();
    let rest = json[start..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '-')
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

// ---------------------------------------------------------------------------
// Base64 encode/decode — minimal implementation to avoid extra dependencies
// ---------------------------------------------------------------------------

const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.bytes() {
        let val = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'\n' | b'\r' | b' ' => continue,
            _ => return Err(format!("invalid base64 char: {}", ch as char)),
        };
        buf = (buf << 6) | val as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Python module: _codepod
// ---------------------------------------------------------------------------

#[allow(non_snake_case)]
#[vm::pymodule]
pub mod _codepod {
    use super::*;
    use vm::{PyResult, VirtualMachine};

    /// Fetch a URL via the host networking bridge.
    ///
    /// Usage: `_codepod.fetch(method, url, headers=None, body=None) -> dict`
    ///
    /// Returns a dict: `{"ok": bool, "status": int, "headers": dict, "body": str, "error": str?}`
    ///
    /// On non-WASM platforms, always raises RuntimeError (host imports not available).
    #[pyfunction]
    fn fetch(
        method: vm::builtins::PyStrRef,
        url: vm::builtins::PyStrRef,
        headers: vm::function::OptionalArg<vm::PyObjectRef>,
        body: vm::function::OptionalArg<vm::PyObjectRef>,
        py_vm: &VirtualMachine,
    ) -> PyResult<vm::PyObjectRef> {
        // Build headers JSON
        let headers_json = match headers {
            vm::function::OptionalArg::Present(ref h) if !py_vm.is_none(h) => py_to_json(h, py_vm),
            _ => "null".to_string(),
        };

        // Build body JSON
        let body_json = match body {
            vm::function::OptionalArg::Present(ref b) if !py_vm.is_none(b) => py_to_json(b, py_vm),
            _ => "null".to_string(),
        };

        let request_json = format!(
            "{{\"method\":\"{}\",\"url\":\"{}\",\"headers\":{},\"body\":{}}}",
            json_escape(method.as_str()),
            json_escape(url.as_str()),
            headers_json,
            body_json,
        );

        #[cfg(target_arch = "wasm32")]
        {
            let response_str = call_host_json(host_network_fetch, &request_json).map_err(|e| {
                py_vm.new_exception_msg(
                    py_vm.ctx.exceptions.runtime_error.to_owned(),
                    format!("fetch failed: {}", e),
                )
            })?;
            json_to_py(&response_str, py_vm)
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = request_json;
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.fetch() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }

    /// Call a host extension method.
    ///
    /// Usage: `_codepod.extension_call(extension, method, **kwargs) -> result`
    ///
    /// Raises RuntimeError if the call fails or if not running in WASM.
    #[pyfunction]
    fn extension_call(
        extension: vm::builtins::PyStrRef,
        method: vm::builtins::PyStrRef,
        kwargs: vm::function::KwArgs,
        py_vm: &VirtualMachine,
    ) -> PyResult<vm::PyObjectRef> {
        // Build kwargs JSON object
        let mut kw_parts = Vec::new();
        for (key, value) in kwargs.into_iter() {
            kw_parts.push(format!(
                "\"{}\":{}",
                json_escape(&key),
                py_to_json(&value, py_vm)
            ));
        }
        let kwargs_json = format!("{{{}}}", kw_parts.join(","));

        let request_json = format!(
            "{{\"extension\":\"{}\",\"method\":\"{}\",\"args\":{}}}",
            json_escape(extension.as_str()),
            json_escape(method.as_str()),
            kwargs_json,
        );

        #[cfg(target_arch = "wasm32")]
        {
            let response_str =
                call_host_json(host_extension_invoke, &request_json).map_err(|e| {
                    py_vm.new_exception_msg(
                        py_vm.ctx.exceptions.runtime_error.to_owned(),
                        format!("extension_call failed: {}", e),
                    )
                })?;
            json_to_py(&response_str, py_vm)
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = request_json;
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.extension_call() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }

    // ----- Native module bridge -----

    /// Call a method on a dynamically loaded native module.
    ///
    /// Usage: `_codepod.native_call(module, method, args_json) -> str`
    ///
    /// Returns JSON response string from the native module.
    #[pyfunction]
    fn native_call(
        module: vm::builtins::PyStrRef,
        method: vm::builtins::PyStrRef,
        args_json: vm::builtins::PyStrRef,
        py_vm: &VirtualMachine,
    ) -> PyResult<vm::PyObjectRef> {
        #[cfg(target_arch = "wasm32")]
        {
            let module_bytes = module.as_str().as_bytes();
            let method_bytes = method.as_str().as_bytes();
            let args_bytes = args_json.as_str().as_bytes();

            let mut out_buf = vec![0u8; 65536]; // 64KB initial
            let rc = unsafe {
                host_native_invoke(
                    module_bytes.as_ptr(), module_bytes.len() as u32,
                    method_bytes.as_ptr(), method_bytes.len() as u32,
                    args_bytes.as_ptr(), args_bytes.len() as u32,
                    out_buf.as_mut_ptr(), out_buf.len() as u32,
                )
            };

            if rc < 0 {
                return Err(py_vm.new_exception_msg(
                    py_vm.ctx.exceptions.runtime_error.to_owned(),
                    format!("native_call failed with error code {}", rc),
                ));
            }

            let len = rc as usize;
            if len > out_buf.len() {
                // Retry with larger buffer
                out_buf.resize(len, 0);
                let rc2 = unsafe {
                    host_native_invoke(
                        module_bytes.as_ptr(), module_bytes.len() as u32,
                        method_bytes.as_ptr(), method_bytes.len() as u32,
                        args_bytes.as_ptr(), args_bytes.len() as u32,
                        out_buf.as_mut_ptr(), out_buf.len() as u32,
                    )
                };
                if rc2 < 0 {
                    return Err(py_vm.new_exception_msg(
                        py_vm.ctx.exceptions.runtime_error.to_owned(),
                        format!("native_call retry failed: {}", rc2),
                    ));
                }
                out_buf.truncate(rc2 as usize);
            } else {
                out_buf.truncate(len);
            }

            let result_str = String::from_utf8(out_buf).map_err(|e| {
                py_vm.new_exception_msg(
                    py_vm.ctx.exceptions.runtime_error.to_owned(),
                    format!("invalid UTF-8 in native response: {}", e),
                )
            })?;

            Ok(py_vm.ctx.new_str(result_str).into())
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = (module, method, args_json);
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.native_call() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }

    // ----- Socket operations (full mode) -----

    /// Open a TCP or TLS socket to host:port.
    ///
    /// Usage: `_codepod.socket_connect(host, port, tls=False) -> int`
    ///
    /// Returns a socket_id for use with socket_send/recv/close.
    #[pyfunction]
    fn socket_connect(
        host: vm::builtins::PyStrRef,
        port: u16,
        tls: vm::function::OptionalArg<bool>,
        py_vm: &VirtualMachine,
    ) -> PyResult<u32> {
        let use_tls = tls.unwrap_or(false);
        let request_json = format!(
            "{{\"host\":\"{}\",\"port\":{},\"tls\":{}}}",
            json_escape(host.as_str()),
            port,
            use_tls,
        );

        #[cfg(target_arch = "wasm32")]
        {
            let response_str = call_host_json(host_socket_connect, &request_json)
                .map_err(|e| os_err(py_vm, &format!("socket_connect failed: {}", e)))?;
            // Parse JSON response directly (avoid Python dict overhead)
            let ok = response_str.contains("\"ok\":true") || response_str.contains("\"ok\": true");
            if !ok {
                let err = extract_json_string(&response_str, "error")
                    .unwrap_or_else(|| "unknown error".to_string());
                return Err(os_err(py_vm, &format!("socket_connect: {}", err)));
            }
            let sid = extract_json_number(&response_str, "socket_id")
                .ok_or_else(|| os_err(py_vm, "socket_connect: missing socket_id"))?;
            Ok(sid as u32)
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = request_json;
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.socket_connect() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }

    /// Send data on an open socket.
    ///
    /// Usage: `_codepod.socket_send(socket_id, data) -> int`
    ///
    /// Returns bytes sent.
    #[pyfunction]
    fn socket_send(
        socket_id: u32,
        data: vm::builtins::PyBytesRef,
        py_vm: &VirtualMachine,
    ) -> PyResult<usize> {
        let data_bytes = data.as_ref();
        let data_b64 = base64_encode(data_bytes);
        let request_json = format!(
            "{{\"socket_id\":{},\"data_b64\":\"{}\"}}",
            socket_id, data_b64,
        );

        #[cfg(target_arch = "wasm32")]
        {
            let response_str = call_host_json(host_socket_send, &request_json)
                .map_err(|e| os_err(py_vm, &format!("socket_send failed: {}", e)))?;
            let ok = response_str.contains("\"ok\":true") || response_str.contains("\"ok\": true");
            if !ok {
                let err = extract_json_string(&response_str, "error")
                    .unwrap_or_else(|| "unknown error".to_string());
                return Err(os_err(py_vm, &format!("socket_send: {}", err)));
            }
            let bs = extract_json_number(&response_str, "bytes_sent").unwrap_or(0);
            Ok(bs as usize)
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = request_json;
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.socket_send() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }

    /// Receive data from an open socket.
    ///
    /// Usage: `_codepod.socket_recv(socket_id, max_bytes) -> bytes`
    ///
    /// Returns received bytes (empty bytes = EOF).
    #[pyfunction]
    fn socket_recv(
        socket_id: u32,
        max_bytes: usize,
        py_vm: &VirtualMachine,
    ) -> PyResult<vm::PyObjectRef> {
        let request_json = format!(
            "{{\"socket_id\":{},\"max_bytes\":{}}}",
            socket_id, max_bytes,
        );

        #[cfg(target_arch = "wasm32")]
        {
            let response_str = call_host_json(host_socket_recv, &request_json)
                .map_err(|e| os_err(py_vm, &format!("socket_recv failed: {}", e)))?;
            let ok = response_str.contains("\"ok\":true") || response_str.contains("\"ok\": true");
            if !ok {
                let err = extract_json_string(&response_str, "error")
                    .unwrap_or_else(|| "unknown error".to_string());
                return Err(os_err(py_vm, &format!("socket_recv: {}", err)));
            }
            let data_b64 = extract_json_string(&response_str, "data_b64").unwrap_or_default();
            let decoded = base64_decode(&data_b64)
                .map_err(|e| os_err(py_vm, &format!("socket_recv: base64 decode error: {}", e)))?;
            Ok(py_vm.ctx.new_bytes(decoded).into())
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = request_json;
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.socket_recv() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }

    /// Close an open socket.
    ///
    /// Usage: `_codepod.socket_close(socket_id)`
    #[pyfunction]
    fn socket_close(socket_id: u32, py_vm: &VirtualMachine) -> PyResult<()> {
        let request_json = format!("{{\"socket_id\":{}}}", socket_id);

        #[cfg(target_arch = "wasm32")]
        {
            let req_bytes = request_json.as_bytes();
            let rc = unsafe { host_socket_close(req_bytes.as_ptr(), req_bytes.len() as u32) };
            if rc < 0 {
                return Err(os_err(
                    py_vm,
                    &format!("socket_close failed: error code {}", rc),
                ));
            }
            Ok(())
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = request_json;
            Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "_codepod.socket_close() is only available inside a WASM sandbox".to_owned(),
            ))
        }
    }
}

/// Public entry point for module registration.
pub fn module_def(ctx: &vm::Context) -> &'static vm::builtins::PyModuleDef {
    _codepod::module_def(ctx)
}
