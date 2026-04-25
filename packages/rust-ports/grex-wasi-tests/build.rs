//! Copy upstream grex test files into OUT_DIR with the
//! `#![cfg(not(target_family = "wasm"))]` top-level gate stripped. This
//! lets `include!` pull them into our own test crate under wasm32-wasip1
//! without touching the upstream source tree.
//!
//! The transform is a narrow one: we remove the first line matching
//! `^#!\[cfg\(not\(target_family = "wasm"\)\)\]$` and copy everything
//! else byte-for-byte.
//!
//! The wasip1 stdlib-panic workaround lives elsewhere — see the
//! `codepod-wasi-shims` runtime dep and the `codepod-wasi-postlink`
//! runner configured in `.cargo/config.toml`.

use std::{env, fs, path::PathBuf};

const UPSTREAM: &[&str] = &[
    "../grex/tests/lib_integration_tests.rs",
    "../grex/tests/property_tests.rs",
];

fn main() {
    let out_dir: PathBuf = env::var_os("OUT_DIR")
        .expect("OUT_DIR not set")
        .into();

    for rel in UPSTREAM {
        println!("cargo:rerun-if-changed={rel}");
        let src = fs::read_to_string(rel)
            .unwrap_or_else(|e| panic!("reading {rel}: {e}"));
        let transformed = strip_wasm_cfg_gate(&src, rel);
        let name = std::path::Path::new(rel)
            .file_name()
            .expect("upstream path has no file_name")
            .to_string_lossy()
            .into_owned();
        let dst = out_dir.join(name);
        fs::write(&dst, transformed)
            .unwrap_or_else(|e| panic!("writing {}: {e}", dst.display()));
    }
}

fn strip_wasm_cfg_gate(src: &str, rel: &str) -> String {
    let target = r#"#![cfg(not(target_family = "wasm"))]"#;
    let mut out = String::with_capacity(src.len());
    let mut stripped = false;
    for line in src.lines() {
        if !stripped && line.trim() == target {
            stripped = true;
            out.push('\n');
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    assert!(
        stripped,
        "grex-wasi-tests build.rs: did not find the expected `#![cfg(not(target_family = \"wasm\"))]` gate in {rel}. \
         Has upstream grex changed its test-file preamble?"
    );
    out
}
