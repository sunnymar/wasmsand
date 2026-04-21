use anyhow::{Context, Result};
use clap::Parser;
use std::process::{Command, ExitCode};

mod wasi_sdk;

#[derive(Parser, Debug)]
#[command(name = "cpcc", version, about = "Clang wrapper for the codepod guest compatibility runtime", long_about = None)]
struct Cli {
    /// Print the clang command that would be executed, and exit 0.
    #[arg(long)]
    dry_run: bool,

    /// Print the wasi-sdk root cpcc discovered, and exit 0. Scripts and
    /// test harnesses use this to avoid re-implementing discovery.
    #[arg(long = "print-sdk-path")]
    print_sdk_path: bool,

    /// Arguments forwarded to clang.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn build_clang_invocation(
    sdk: &wasi_sdk::WasiSdk,
    user_args: &[String],
) -> Vec<std::ffi::OsString> {
    let mut argv: Vec<std::ffi::OsString> = Vec::new();
    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
    argv.push("-O2".into());
    argv.push("-std=c11".into());
    argv.push("-Wall".into());
    argv.push("-Wextra".into());
    for a in user_args {
        argv.push(a.into());
    }
    argv
}

fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;

    if cli.print_sdk_path {
        println!("{}", sdk.root.display());
        return Ok(ExitCode::SUCCESS);
    }

    let argv = build_clang_invocation(&sdk, &cli.args);

    if cli.dry_run {
        print!("{}", sdk.clang().display());
        for a in &argv {
            print!(" {}", a.to_string_lossy());
        }
        println!();
        return Ok(ExitCode::SUCCESS);
    }

    let status = Command::new(sdk.clang())
        .args(&argv)
        .status()
        .with_context(|| format!("spawning {}", sdk.clang().display()))?;
    if let Some(code) = status.code() {
        Ok(ExitCode::from(code as u8))
    } else {
        Ok(ExitCode::FAILURE)
    }
}
