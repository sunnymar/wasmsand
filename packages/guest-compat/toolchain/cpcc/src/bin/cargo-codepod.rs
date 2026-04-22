use anyhow::{anyhow, Context, Result};
use cpcc_toolchain::cargo_codepod::{plan_invocation_with_sdk, Subcommand};
use cpcc_toolchain::{archive, env as cpcc_env, wasi_sdk};
use std::process::{Command, ExitCode};

fn main() -> Result<ExitCode> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(|s| s.as_str()) == Some("codepod") {
        argv.remove(0);
    }
    if argv.is_empty() {
        return Err(anyhow!(
            "cargo-codepod: expected a subcommand (build, test, run, download-toolchain)"
        ));
    }
    let sub_name = argv.remove(0);
    let sub = Subcommand::parse(&sub_name)?;

    if sub == Subcommand::DownloadToolchain {
        // Implemented in Task 11.
        return Err(anyhow!(
            "cargo-codepod: download-toolchain not yet implemented (Task 11)"
        ));
    }

    let mut dry_run = false;
    argv.retain(|a| {
        if a == "--dry-run" {
            dry_run = true;
            false
        } else {
            true
        }
    });

    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let process_env = cpcc_env::Env::from_process();

    // §Versioning: the version check runs against the same llvm-nm the C
    // wrapper uses. It is presence-only at Step 1; future tightening to an
    // exact major/minor match is owned by archive::check_version.
    if let Some(archive_path) = &process_env.archive {
        if !process_env.skip_version_check {
            archive::check_version(&sdk.nm(), archive_path)
                .context("cargo-codepod: archive version check")?;
        }
    }

    let clang = sdk.clang();
    let plan = plan_invocation_with_sdk(sub, &argv, Some(&clang))?;

    if dry_run {
        for (k, v) in &plan.env {
            println!("{k}={v}");
        }
        print!("cargo");
        for a in &plan.cargo_args {
            print!(" {a}");
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    // Spawn real cargo with the planned args and env additions. Inherits
    // stdio so cargo's own progress shows through. Pre-opt preservation
    // and wasm-opt run in Task 10.
    let mut cmd = Command::new("cargo");
    cmd.args(&plan.cargo_args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    let status = cmd.status().context("spawning cargo")?;
    Ok(status
        .code()
        .map(|c| ExitCode::from(c as u8))
        .unwrap_or(ExitCode::FAILURE))
}
