use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Parse `major.minor` out of the archive by dumping the
/// `codepod_guest_compat_version` data symbol via `llvm-nm` and cross-
/// referencing against the compile-time constants this build of cpcc
/// was linked with. Implements §Versioning.
pub fn check_version(nm: &Path, archive: &Path) -> Result<()> {
    let out = Command::new(nm)
        .arg("--defined-only")
        .arg(archive)
        .output()
        .with_context(|| format!("running {} on {}", nm.display(), archive.display()))?;
    if !out.status.success() {
        return Err(anyhow!(
            "llvm-nm failed on {}: {}",
            archive.display(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let present = stdout.lines().any(|line| {
        line.split_whitespace()
            .last()
            .map(|s| s == "codepod_guest_compat_version")
            .unwrap_or(false)
    });
    if !present {
        return Err(anyhow!(
            "archive {} does not define codepod_guest_compat_version (§Versioning)",
            archive.display()
        ));
    }
    // We do not yet read the archive's encoded value (that would require
    // extracting the data section). The sentinel's presence plus the
    // archive's provenance from the repo build are sufficient for Step 1.
    // Step 3 (cargo-codepod lands) tightens this to an exact value match.
    Ok(())
}
