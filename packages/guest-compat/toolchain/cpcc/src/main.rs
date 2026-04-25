use anyhow::{Context, Result};
use clap::Parser;
use std::ffi::OsString;
use std::process::{Command, ExitCode};

use cpcc_toolchain::{archive, env, preserve, wasi_sdk, wasm_opt, TIER1};

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
    // Relocatable (-r / --relocatable) and partial links must NOT receive the
    // --whole-archive compat injection: the archive symbols would end up in
    // intermediate .o files and cause duplicate-symbol errors when the final
    // link re-injects the archive. Only the final executable link step gets
    // the injection.
    !user_args
        .iter()
        .any(|a| a == "-c" || a == "-E" || a == "-S" || a == "-r" || a == "--relocatable")
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
    //
    // When the archive is present:
    // - Pass --no-wasm-opt so that clang's automatic wasm-opt invocation
    //   is suppressed. cpcc captures the linker output as the "pre-opt"
    //   artifact (§Verifying Precedence) and runs wasm-opt separately via
    //   CPCC_WASM_OPT_FLAGS / CPCC_NO_WASM_OPT. Without this flag the
    //   clang driver runs wasm-opt itself before cpcc can preserve the
    //   pre-opt wasm, which makes stage 3 of cpcheck unverifiable.
    // - Export each Tier 1 symbol and its marker so that cpcheck's
    //   §Verifying Precedence stages 2 and 3 can locate them by name in
    //   the export section of the pre-opt .wasm.
    if let Some(archive) = env.archive.as_ref() {
        if is_link_invocation(user_args) {
            argv.push("--no-wasm-opt".into());
            argv.push("-Wl,--whole-archive".into());
            argv.push(archive.clone().into_os_string());
            argv.push("-Wl,--no-whole-archive".into());
            for sym in TIER1 {
                argv.push(format!("-Wl,--export={sym}").into());
                argv.push(format!("-Wl,--export=__codepod_guest_compat_marker_{sym}").into());
            }
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

    // Post-link: pre-opt preservation is gated on the user naming a
    // `.wasm` output (canary/test builds), but wasm-opt runs against
    // any link output — BusyBox links to `busybox_unstripped` with no
    // extension, and that binary is still wasm by virtue of
    // --target=wasm32-wasip1 and still wants the --asyncify pass.
    if is_link_invocation(&cli.args) {
        if let Some(out_wasm) = preserve::output_wasm(&cli.args) {
            preserve::copy_to_preserve(&out_wasm, env.preserve_pre_opt.as_deref())?;
        }
        if let Some(out_path) = preserve::output_path(&cli.args) {
            wasm_opt::maybe_run(&out_path, &env.wasm_opt)?;
        }
    }

    Ok(ExitCode::SUCCESS)
}
