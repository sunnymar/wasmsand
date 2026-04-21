use std::fs;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_cpcc")
}

#[test]
fn help_prints_usage() {
    let out = Command::new(bin())
        .arg("--help")
        .output()
        .expect("run cpcc --help");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("cpcc"), "help output: {stdout}");
    assert!(stdout.contains("Usage"), "help output: {stdout}");
}

#[test]
fn version_prints_version() {
    let out = Command::new(bin())
        .arg("--version")
        .output()
        .expect("run cpcc --version");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.contains(env!("CARGO_PKG_VERSION")),
        "version output: {stdout}"
    );
}

#[test]
fn invoking_clang_respects_env_sdk() {
    // Build a fake wasi-sdk layout in a temp dir and point WASI_SDK_PATH at
    // it. cpcc --dry-run must print the clang path it would exec,
    // which should be <fake>/bin/clang.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot")).unwrap();
    let clang = root.join("bin/clang");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", root)
        .arg("--dry-run")
        .arg("foo.c")
        .arg("-o")
        .arg("foo.wasm")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.contains(clang.to_str().unwrap()),
        "dry-run stdout: {stdout}"
    );
    assert!(
        stdout.contains("--target=wasm32-wasip1"),
        "dry-run stdout: {stdout}"
    );
    assert!(stdout.contains("--sysroot="), "dry-run stdout: {stdout}");
}
