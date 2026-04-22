//! `cargo-codepod` cargo subcommand (§Toolchain Integration > Rust Toolchain).
//! Wraps real `cargo` with the wasm32-wasip1 target, the wasi-sdk linker,
//! the compat-archive RUSTFLAGS framing, the `CODEPOD_LINK_INJECTED=1`
//! handshake with the optional `-sys` crate, version checking, pre-opt wasm
//! preservation, and post-link `wasm-opt`.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Subcommand {
    Build,
    Test,
    Run,
    DownloadToolchain,
}

impl Subcommand {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "build" => Ok(Self::Build),
            "test" => Ok(Self::Test),
            "run" => Ok(Self::Run),
            "download-toolchain" => Ok(Self::DownloadToolchain),
            other => Err(anyhow!(
                "unknown cargo-codepod subcommand {other:?} (expected build/test/run/download-toolchain)"
            )),
        }
    }
    pub fn cargo_verb(self) -> Option<&'static str> {
        match self {
            Self::Build => Some("build"),
            Self::Test => Some("test"),
            Self::Run => Some("run"),
            Self::DownloadToolchain => None,
        }
    }
}

/// What the wrapper plans to do. `execute_plan` consumes this; tests inspect
/// it without spawning cargo.
#[derive(Debug, Default)]
pub struct InvocationPlan {
    pub cargo_args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Compute the cargo invocation for `sub` plus `forwarded` user args.
/// Reads CPCC_ARCHIVE / CPCC_INCLUDE / CPCC_PRESERVE_PRE_OPT etc. from the
/// process environment via the existing `crate::env::Env`. RUSTFLAGS is only
/// injected when an archive is present — bare `cargo codepod build` with no
/// archive surfaces "missing archive" instead of a confusing link error.
pub fn plan_invocation(sub: Subcommand, forwarded: &[String]) -> Result<InvocationPlan> {
    let env = crate::env::Env::from_process();
    let mut plan = InvocationPlan::default();

    let verb = sub
        .cargo_verb()
        .ok_or_else(|| anyhow!("subcommand {sub:?} does not correspond to a cargo verb"))?;
    plan.cargo_args.push(verb.to_string());
    plan.cargo_args.push("--target=wasm32-wasip1".to_string());
    for arg in forwarded {
        plan.cargo_args.push(arg.clone());
    }

    plan.env.push(("CODEPOD_LINK_INJECTED".to_string(), "1".to_string()));

    if let Some(archive) = &env.archive {
        // §Override And Link Precedence: --whole-archive bracket the compat
        // archive, then per-Tier-1-symbol --export framing so the
        // implementation-signature check can find the markers in the pre-opt
        // wasm.
        let mut rustflags = String::new();
        rustflags.push_str("-C link-arg=-Wl,--whole-archive ");
        rustflags.push_str(&format!("-C link-arg={} ", archive.display()));
        rustflags.push_str("-C link-arg=-Wl,--no-whole-archive ");
        for sym in crate::TIER1 {
            rustflags.push_str(&format!("-C link-arg=-Wl,--export={sym} "));
            rustflags.push_str(&format!(
                "-C link-arg=-Wl,--export=__codepod_guest_compat_marker_{sym} "
            ));
        }
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            rustflags.trim_end().to_string(),
        ));
    }

    Ok(plan)
}
