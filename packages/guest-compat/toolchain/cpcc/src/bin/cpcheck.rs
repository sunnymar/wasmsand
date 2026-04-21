use anyhow::{Context, Result};
use clap::Parser;
use cpcc_toolchain::{precheck, wasi_sdk};
use std::path::PathBuf;
use std::process::ExitCode;

const TIER1: &[&str] = &[
    "dup2",
    "getgroups",
    "sched_getaffinity",
    "sched_setaffinity",
    "sched_getcpu",
    "signal",
    "sigaction",
    "raise",
    "alarm",
    "sigemptyset",
    "sigfillset",
    "sigaddset",
    "sigdelset",
    "sigismember",
    "sigprocmask",
    "sigsuspend",
];

#[derive(Parser)]
#[command(about = "§Verifying Precedence: archive + pre-opt wasm implementation-signature check")]
struct Args {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long = "pre-opt-wasm")]
    pre_opt_wasm: PathBuf,
    /// Subset of Tier 1 symbols to verify. If omitted, all of Tier 1.
    #[arg(long = "symbol")]
    symbols: Vec<String>,
}

fn main() -> Result<ExitCode> {
    let args = Args::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk for llvm-nm")?;
    let symbols: Vec<&str> = if args.symbols.is_empty() {
        TIER1.to_vec()
    } else {
        args.symbols.iter().map(String::as_str).collect()
    };
    precheck::check_archive(&sdk.nm(), &args.archive, &symbols)?;
    precheck::check_wasm(&args.pre_opt_wasm, &symbols)?;
    println!("signature check: OK ({} symbols)", symbols.len());
    Ok(ExitCode::SUCCESS)
}
