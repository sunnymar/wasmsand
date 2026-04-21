use anyhow::Result;
use clap::Parser;

/// cpcc — clang wrapper for the codepod guest compatibility runtime.
///
/// This is a driver wrapper (§Toolchain Integration). It takes the same
/// positional arguments as clang and forwards them, after injecting the
/// codepod sysroot, include paths, and link-time compat archive framing
/// (§Override And Link Precedence).
#[derive(Parser, Debug)]
#[command(name = "cpcc", version, about, long_about = None)]
struct Cli {
    /// Arguments forwarded to clang (everything after a `--` separator, or
    /// arguments that do not match a cpcc-specific flag).
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn main() -> Result<()> {
    let _cli = Cli::parse();
    // Later tasks: wasi-sdk discovery, sysroot/target injection, link-arg
    // injection, pre-opt preservation, optional wasm-opt, version check.
    Ok(())
}
