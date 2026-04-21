use anyhow::Result;
use clap::Parser;
use cpcc_toolchain::conform;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "cpconf",
    version,
    about = "Guest compatibility conformance driver (§Conformance Testing)"
)]
struct Args {
    /// Skip rebuilding cpcc/cpar/cpcheck (assume they are already up to date).
    #[arg(long)]
    skip_toolchain_build: bool,
    /// Skip the orchestrator behavioral canary suite (useful for CI that runs it separately).
    #[arg(long)]
    skip_behavioral: bool,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let root = conform::detect_repo_root()?;
    let driver = conform::Driver::new(root);
    if !args.skip_toolchain_build {
        driver.ensure_toolchain()?;
    }
    driver.build_archive_and_canaries()?;
    driver.run_signature_checks()?;
    if !args.skip_behavioral {
        driver.run_behavioral_suite()?;
    }
    println!("cpconf: OK");
    Ok(ExitCode::SUCCESS)
}
