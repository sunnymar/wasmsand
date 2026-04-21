use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::Command;

/// Canary → Tier 1 symbol that canary exercises. Canaries whose names
/// are not in this map still build and run, but do not drive an
/// implementation-signature check.
pub fn canary_symbol_map() -> &'static [(&'static str, &'static str)] {
    &[
        ("dup2-canary", "dup2"),
        ("getgroups-canary", "getgroups"),
        ("affinity-canary", "sched_getaffinity"),
        ("signal-canary", "signal"),
    ]
}

pub struct Driver {
    pub repo_root: PathBuf,
}

impl Driver {
    pub fn new(repo_root: PathBuf) -> Self {
        Self { repo_root }
    }

    fn target_bin(&self, name: &str) -> PathBuf {
        self.repo_root.join("target/release").join(name)
    }

    fn guest_compat(&self) -> PathBuf {
        self.repo_root.join("packages/guest-compat")
    }

    pub fn ensure_toolchain(&self) -> Result<()> {
        // `cargo build --release -p cpcc-toolchain` builds every bin in the crate.
        let status = Command::new("cargo")
            .current_dir(&self.repo_root)
            .args(["build", "--release", "-p", "cpcc-toolchain"])
            .status()
            .context("spawning cargo build -p cpcc-toolchain")?;
        if !status.success() {
            return Err(anyhow!("cargo build -p cpcc-toolchain failed"));
        }
        Ok(())
    }

    pub fn build_archive_and_canaries(&self) -> Result<()> {
        let status = Command::new("make")
            .current_dir(self.guest_compat())
            .args(["all", "copy-fixtures"])
            .status()
            .context("make -C packages/guest-compat all copy-fixtures")?;
        if !status.success() {
            return Err(anyhow!("make -C packages/guest-compat failed"));
        }
        Ok(())
    }

    pub fn run_signature_checks(&self) -> Result<()> {
        let cpcheck = self.target_bin("cpcheck");
        let archive = self.guest_compat().join("build/libcodepod_guest_compat.a");
        let build_dir = self.guest_compat().join("build");
        let mut failed = Vec::new();
        for (canary, sym) in canary_symbol_map() {
            let pre_opt = build_dir.join(format!("{canary}.pre-opt.wasm"));
            println!("== {canary} ({sym}) ==");
            let status = Command::new(&cpcheck)
                .arg("--archive")
                .arg(&archive)
                .arg("--pre-opt-wasm")
                .arg(&pre_opt)
                .arg("--symbol")
                .arg(*sym)
                .status()
                .with_context(|| format!("running cpcheck on {canary}"))?;
            if !status.success() {
                failed.push(*canary);
            }
        }
        if !failed.is_empty() {
            return Err(anyhow!("signature check failed for: {}", failed.join(", ")));
        }
        Ok(())
    }

    pub fn run_behavioral_suite(&self) -> Result<()> {
        // Delegate to the orchestrator canary suite. This is the Step 1
        // behavioral harness; Step 3a replaces it with TOML-driven spec
        // tests.
        let status = Command::new("deno")
            .current_dir(&self.repo_root)
            .args([
                "test",
                "-A",
                "--no-check",
                "packages/orchestrator/src/__tests__/guest-compat.test.ts",
            ])
            .status()
            .context("spawning deno test")?;
        if !status.success() {
            return Err(anyhow!("orchestrator canary suite failed"));
        }
        Ok(())
    }
}

pub fn detect_repo_root() -> Result<PathBuf> {
    // Walk upward from CWD until we find a Cargo.toml with `[workspace]`.
    let mut cur = std::env::current_dir()?;
    loop {
        let cargo = cur.join("Cargo.toml");
        if cargo.is_file() {
            if let Ok(text) = std::fs::read_to_string(&cargo) {
                if text.contains("[workspace]") {
                    return Ok(cur);
                }
            }
        }
        if !cur.pop() {
            break;
        }
    }
    Err(anyhow!(
        "could not locate repo root from {:?}",
        std::env::current_dir()?
    ))
}
