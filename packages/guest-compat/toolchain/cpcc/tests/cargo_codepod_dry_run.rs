use cpcc_toolchain::cargo_codepod::{plan_invocation, Subcommand};

#[test]
fn build_subcommand_uses_wasm32_wasip1_target() {
    let plan = plan_invocation(Subcommand::Build, &["--release".into()]).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "build"));
    assert!(plan.cargo_args.iter().any(|a| a == "--target=wasm32-wasip1"));
    assert!(plan.cargo_args.iter().any(|a| a == "--release"));
}

#[test]
fn test_subcommand_uses_wasm32_wasip1_target() {
    let plan = plan_invocation(Subcommand::Test, &[]).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "test"));
    assert!(plan.cargo_args.iter().any(|a| a == "--target=wasm32-wasip1"));
}

#[test]
fn run_subcommand_uses_wasm32_wasip1_target() {
    let plan = plan_invocation(Subcommand::Run, &["--bin".into(), "foo".into()]).unwrap();
    assert!(plan.cargo_args.iter().any(|a| a == "run"));
    assert!(plan.cargo_args.iter().any(|a| a == "--target=wasm32-wasip1"));
    assert!(plan.cargo_args.iter().any(|a| a == "--bin"));
    assert!(plan.cargo_args.iter().any(|a| a == "foo"));
}

#[test]
fn injected_env_includes_codepod_link_injected() {
    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();
    assert_eq!(
        plan.env.iter().find(|(k, _)| k == "CODEPOD_LINK_INJECTED").map(|(_, v)| v.as_str()),
        Some("1"),
    );
}

#[test]
fn dry_run_does_not_set_target_specific_env_when_archive_missing() {
    // Without CPCC_ARCHIVE pointing somewhere real, the linker/RUSTFLAGS env
    // vars are not set — letting the user diagnose "where's my archive?"
    // before they run a build.
    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();
    let has_rustflags = plan.env.iter().any(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS");
    assert!(!has_rustflags, "RUSTFLAGS should not be injected when archive is unset");
}
