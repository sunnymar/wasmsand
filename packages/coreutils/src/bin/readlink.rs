use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Normalize a path without hitting the filesystem for canonicalization.
/// Resolves `.` and `..` components, prepends cwd if relative.
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
            Component::RootDir => {
                out.push("/");
            }
            Component::Normal(s) => {
                out.push(s);
            }
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            Component::Prefix(_) => {
                out.push(c);
            }
        }
    }
    out.to_string_lossy().into_owned()
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Parse flags: -f (canonicalize), -e (canonicalize, must exist), -m (canonicalize, no
    // existence check), -n (no newline), -s (quiet), -v (verbose), -q (quiet).
    // For our purposes the distinction between -f/-e/-m is handled by canonicalize;
    // -n suppresses the trailing newline.
    let mut canonicalize = false;
    let mut no_newline = false;

    let paths: Vec<&str> = args
        .iter()
        .filter_map(|a| {
            if a.starts_with('-') {
                if a.contains('f') || a.contains('e') || a.contains('m') {
                    canonicalize = true;
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
        let result = if canonicalize {
            // Try fs::canonicalize first (resolves symlinks). On WASI, the
            // underlying path_readlink syscall either returns ENOTSUP for
            // regular files or ENOSYS if not implemented at all. Either way,
            // fall back to pure lexical normalization, which is correct for
            // paths that contain no symlink components.
            match fs::canonicalize(path) {
                Ok(p) => Ok(p.to_string_lossy().into_owned()),
                Err(_) => Ok(normalize_path(path)),
            }
        } else {
            fs::read_link(path).map(|p| p.to_string_lossy().into_owned())
        };

        match result {
            Ok(target) => {
                if no_newline {
                    print!("{target}");
                } else {
                    println!("{target}");
                }
            }
            Err(e) => {
                eprintln!("readlink: {path}: {e}");
                exit_code = 1;
            }
        }
    }

    std::process::exit(exit_code);
}
