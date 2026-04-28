// Runs upstream grex's tests/property_tests.rs against wasm32-wasip1
// via wasmtime, with the upstream `#![cfg(not(target_family = "wasm"))]`
// gate stripped by build.rs. See Cargo.toml for rationale.

// Forces codepod-wasi-shims into the test binary's link.
#[used]
static _FORCE_WASI_SHIMS: fn() -> std::path::PathBuf = grex_wasi_tests::force_wasi_shims;

include!(concat!(env!("OUT_DIR"), "/property_tests.rs"));
