use anyhow::{Context, Result};
use clap::Parser;
use std::ffi::OsString;
use std::process::{Command, ExitCode};

mod archive;
mod env;
mod preserve;
mod wasi_sdk;
mod wasm_opt;

#[derive(Parser, Debug)]
#[command(name = "cpcc", version, about = "Clang wrapper for the codepod guest compatibility runtime", long_about = None)]
struct Cli {
    #[arg(long)]
    dry_run: bool,

    #[arg(long = "print-sdk-path")]
    print_sdk_path: bool,

    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn is_link_invocation(user_args: &[String]) -> bool {
    !user_args
        .iter()
        .any(|a| a == "-c" || a == "-E" || a == "-S")
}

fn build_clang_invocation(
    sdk: &wasi_sdk::WasiSdk,
    env: &env::Env,
    user_args: &[String],
) -> Vec<OsString> {
    let mut argv: Vec<OsString> = Vec::new();
    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
    argv.push("-O2".into());
    argv.push("-std=c11".into());
    argv.push("-Wall".into());
    argv.push("-Wextra".into());
    if let Some(inc) = env.include.as_ref() {
        argv.push("-isystem".into());
        argv.push(inc.clone().into_os_string());
    }
    for a in user_args {
        argv.push(a.into());
    }
    // Link-arg framing must come after the user's objects so it is last in
    // the link line. The whole-archive pair must bracket only the compat
    // archive, and the whole thing must precede `-lc`. clang's default is
    // to insert `-lc` at the very end, so appending these three args is
    // sufficient.
    if let Some(archive) = env.archive.as_ref() {
        if is_link_invocation(user_args) {
            argv.push("-Wl,--whole-archive".into());
            argv.push(archive.clone().into_os_string());
            argv.push("-Wl,--no-whole-archive".into());
        }
    }
    argv
}

fn main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let sdk = wasi_sdk::discover().context("locating wasi-sdk")?;
    let env = env::Env::from_process();

    if cli.print_sdk_path {
        println!("{}", sdk.root.display());
        return Ok(ExitCode::SUCCESS);
    }

    if let Some(archive) = env.archive.as_ref() {
        if !env.skip_version_check {
            archive::check_version(&sdk.nm(), archive).context("version check")?;
        }
    }

    let argv = build_clang_invocation(&sdk, &env, &cli.args);

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
    if !status.success() {
        return Ok(status
            .code()
            .map(|c| ExitCode::from(c as u8))
            .unwrap_or(ExitCode::FAILURE));
    }

    // Post-link: if an output `.wasm` was produced and the user asked for
    // pre-opt preservation, copy the just-linked binary to the stable path
    // BEFORE any optional wasm-opt pass.
    if let Some(out_wasm) = preserve::output_wasm(&cli.args) {
        preserve::copy_to_preserve(&out_wasm, env.preserve_pre_opt.as_deref())?;
        wasm_opt::maybe_run(&out_wasm, &env.wasm_opt)?;
    }

    Ok(ExitCode::SUCCESS)
}
