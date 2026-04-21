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
