use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Resolve the target `-o` from a user argv. Returns `None` for
/// compile-only invocations (no `-o foo.wasm`) — preservation has
/// nothing to do there. When multiple `-o` appear, follows clang's
/// "last one wins" convention.
pub fn output_wasm(user_args: &[String]) -> Option<PathBuf> {
    let mut iter = user_args.iter();
    let mut last = None;
    while let Some(arg) = iter.next() {
        if arg == "-o" {
            if let Some(v) = iter.next() {
                let p = PathBuf::from(v);
                if p.extension().and_then(|e| e.to_str()) == Some("wasm") {
                    last = Some(p);
                }
            }
        }
    }
    last
}

/// If the user asked for preservation, copy `src` to the preserve path.
/// Otherwise no-op.
pub fn copy_to_preserve(src: &Path, preserve: Option<&Path>) -> Result<()> {
    let Some(dst) = preserve else { return Ok(()) };
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::copy(src, dst)
        .with_context(|| format!("copying {} → {}", src.display(), dst.display()))?;
    Ok(())
}
