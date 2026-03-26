//! Standalone native module WASM for numpy (proof-of-concept).
//!
//! Exports:
//!   invoke(method_ptr, method_len, args_ptr, args_len, out_ptr, out_cap) -> i32
//!   __alloc(size) -> ptr
//!   __dealloc(ptr, size)
//!
//! Each method receives JSON args and returns a JSON result.
//! This POC implements a few basic operations to prove the bridge works.
//! The real implementation will wrap numpy-rust-core.

use std::alloc::{alloc, dealloc, Layout};

// ---------------------------------------------------------------------------
// Memory management exports
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn __alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(size, 1).unwrap();
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn __dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    let layout = Layout::from_size_align(size, 1).unwrap();
    unsafe { dealloc(ptr, layout) }
}

// ---------------------------------------------------------------------------
// invoke() — main dispatch entry point
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn invoke(
    method_ptr: *const u8,
    method_len: usize,
    args_ptr: *const u8,
    args_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> usize {
    let method =
        unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(method_ptr, method_len)) };
    let args =
        unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(args_ptr, args_len)) };

    let result = dispatch(method, args);

    let result_bytes = result.as_bytes();
    if result_bytes.len() > out_cap {
        return result_bytes.len(); // signal: need more space
    }
    unsafe {
        std::ptr::copy_nonoverlapping(result_bytes.as_ptr(), out_ptr, result_bytes.len());
    }
    result_bytes.len()
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

fn dispatch(method: &str, args_json: &str) -> String {
    match method {
        "ping" => {
            format!(r#"{{"ok":true,"echo":{}}}"#, args_json)
        }

        "add" => {
            let args: Vec<f64> = serde_json::from_str(args_json).unwrap_or_default();
            if args.len() >= 2 {
                format!(r#"{{"ok":true,"result":{}}}"#, args[0] + args[1])
            } else {
                r#"{"ok":false,"error":"add requires 2 arguments"}"#.to_string()
            }
        }

        "multiply" => {
            let args: Vec<f64> = serde_json::from_str(args_json).unwrap_or_default();
            if args.len() >= 2 {
                format!(r#"{{"ok":true,"result":{}}}"#, args[0] * args[1])
            } else {
                r#"{"ok":false,"error":"multiply requires 2 arguments"}"#.to_string()
            }
        }

        "array_sum" => {
            let args: Vec<f64> = serde_json::from_str(args_json).unwrap_or_default();
            let sum: f64 = args.iter().sum();
            format!(r#"{{"ok":true,"result":{}}}"#, sum)
        }

        "linspace" => {
            // linspace(start, stop, num) -> array
            let args: Vec<f64> = serde_json::from_str(args_json).unwrap_or_default();
            if args.len() >= 3 {
                let start = args[0];
                let stop = args[1];
                let num = args[2] as usize;
                if num < 2 {
                    format!(r#"{{"ok":true,"result":[{}]}}"#, start)
                } else {
                    let step = (stop - start) / (num - 1) as f64;
                    let vals: Vec<String> = (0..num)
                        .map(|i| format!("{}", start + step * i as f64))
                        .collect();
                    format!(r#"{{"ok":true,"result":[{}]}}"#, vals.join(","))
                }
            } else {
                r#"{"ok":false,"error":"linspace requires 3 arguments: start, stop, num"}"#
                    .to_string()
            }
        }

        "dot" => {
            // dot(a, b) where a and b are flat arrays of same length
            let args: Vec<Vec<f64>> = serde_json::from_str(args_json).unwrap_or_default();
            if args.len() >= 2 && args[0].len() == args[1].len() {
                let result: f64 = args[0].iter().zip(&args[1]).map(|(a, b)| a * b).sum();
                format!(r#"{{"ok":true,"result":{}}}"#, result)
            } else {
                r#"{"ok":false,"error":"dot requires 2 equal-length arrays"}"#.to_string()
            }
        }

        _ => {
            format!(r#"{{"ok":false,"error":"unknown method: {}"}}"#, method)
        }
    }
}
