//! Native `_codepod` module for RustPython.
//!
//! Provides host-bridging functions that replace the magic FD protocol
//! (os.write to fd 1023/1022) with proper native function calls backed
//! by WASM host imports.
//!
//! Functions:
//! - `_codepod.fetch(method, url, headers=None, body=None)` -> dict
//! - `_codepod.extension_call(extension, method, **kwargs)` -> result
//! - `_codepod.is_extension(name)` -> bool

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

    /// Check if a named extension is available. Returns 1 if yes, 0 if no.
    fn host_is_extension(name_ptr: *const u8, name_len: u32) -> i32;
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

    /// Check if a named extension is available on the host.
    ///
    /// Usage: `_codepod.is_extension(name) -> bool`
    ///
    /// Returns False on non-WASM platforms.
    #[pyfunction]
    fn is_extension(name: vm::builtins::PyStrRef, _py_vm: &VirtualMachine) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            let name_bytes = name.as_str().as_bytes();
            unsafe { host_is_extension(name_bytes.as_ptr(), name_bytes.len() as u32) == 1 }
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = name;
            false
        }
    }
}

/// Public entry point for module registration.
pub fn module_def(ctx: &vm::Context) -> &'static vm::builtins::PyModuleDef {
    _codepod::module_def(ctx)
}
