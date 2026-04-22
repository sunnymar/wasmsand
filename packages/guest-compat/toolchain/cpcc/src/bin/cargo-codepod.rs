use anyhow::{anyhow, Result};
use cpcc_toolchain::cargo_codepod::{plan_invocation, Subcommand};
use std::process::ExitCode;

fn main() -> Result<ExitCode> {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    // Cargo invokes `cargo-codepod` as `cargo-codepod codepod <sub> [args...]`,
    // so strip the leading "codepod" if present.
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

    // --dry-run prints the plan and exits without spawning cargo. Useful
    // for tests and for users who want to see what the wrapper would do.
    let mut dry_run = false;
    argv.retain(|a| {
        if a == "--dry-run" {
            dry_run = true;
            false
        } else {
            true
        }
    });

    let plan = plan_invocation(sub, &argv)?;

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

    // Real execution lands in Task 9. For now, dry-run is the only path.
    Err(anyhow!(
        "cargo-codepod: real execution not yet implemented; pass --dry-run for now"
    ))
}
