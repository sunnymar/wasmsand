use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// No flag: print the target of a single symlink. Fails if the path
    /// is not a symlink.
    Readlink,
    /// `-f`: canonicalize; all-but-last component must exist (GNU rule).
    /// Falls back to lexical when canonicalize itself is unsupported.
    Follow,
    /// `-e`: canonicalize; every component must exist.
    Exists,
    /// `-m`: lexical canonicalize; components need not exist.
    Missing,
}

/// Lexical path normalization. Resolves `.` and `..` without touching the
/// filesystem; prepends cwd if relative.
fn normalize_path(path: &str) -> String {
    let p = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        cwd.join(path)
    };

    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::RootDir => out.push("/"),
            Component::Normal(s) => out.push(s),
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            Component::Prefix(_) => out.push(c),
        }
    }
    out.to_string_lossy().into_owned()
}

fn resolve(path: &str, mode: Mode) -> Result<String, String> {
    match mode {
        Mode::Readlink => fs::read_link(path)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string()),

        // -m: lexical only; never fails on existence grounds.
        Mode::Missing => Ok(normalize_path(path)),

        // -e: path must exist. Check before falling back to lexical so
        // that WASI's often-absent canonicalize support doesn't hide a
        // genuine missing path.
        Mode::Exists => {
            if !Path::new(path).exists() {
                return Err(format!("{path}: No such file or directory"));
            }
            match fs::canonicalize(path) {
                Ok(p) => Ok(p.to_string_lossy().into_owned()),
                Err(_) => Ok(normalize_path(path)),
            }
        }

        // -f: all components except the last must exist.
        Mode::Follow => {
            let p = Path::new(path);
            if let Some(parent) = p.parent() {
                if !parent.as_os_str().is_empty() && !parent.exists() {
                    return Err(format!("{path}: No such file or directory"));
                }
            }
            match fs::canonicalize(path) {
                Ok(p) => Ok(p.to_string_lossy().into_owned()),
                Err(_) => Ok(normalize_path(path)),
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Flags: -f (follow, last need not exist), -e (every component must
    // exist), -m (pure lexical), -n (no newline). -s/-q/-v are accepted
    // for compat but don't change behaviour here.
    let mut mode = Mode::Readlink;
    let mut no_newline = false;

    let paths: Vec<&str> = args
        .iter()
        .filter_map(|a| {
            if a.starts_with('-') && a.len() > 1 {
                // Later flag wins, matching GNU readlink.
                if a.contains('f') {
                    mode = Mode::Follow;
                }
                if a.contains('e') {
                    mode = Mode::Exists;
                }
                if a.contains('m') {
                    mode = Mode::Missing;
                }
                if a.contains('n') {
                    no_newline = true;
                }
                None
            } else {
                Some(a.as_str())
            }
        })
        .collect();

    let mut exit_code = 0i32;
    for path in &paths {
        match resolve(path, mode) {
            Ok(target) => {
                if no_newline {
                    print!("{target}");
                } else {
                    println!("{target}");
                }
            }
            Err(msg) => {
                eprintln!("readlink: {msg}");
                exit_code = 1;
            }
        }
    }

    std::process::exit(exit_code);
}
