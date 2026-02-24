use std::env;
use std::fs;
use std::path::Path;
use std::process;

struct Options {
    recursive: bool,
    force: bool,
}

fn remove_path(path: &Path, opts: &Options) -> Result<(), String> {
    if !path.exists() {
        if opts.force {
            return Ok(());
        }
        return Err(format!(
            "cannot remove '{}': No such file or directory",
            path.display()
        ));
    }

    if path.is_dir() {
        if !opts.recursive {
            return Err(format!(
                "cannot remove '{}': Is a directory",
                path.display()
            ));
        }
        fs::remove_dir_all(path).map_err(|e| format!("cannot remove '{}': {}", path.display(), e))
    } else {
        fs::remove_file(path).map_err(|e| format!("cannot remove '{}': {}", path.display(), e))
    }
}

fn main() {
    let mut opts = Options {
        recursive: false,
        force: false,
    };
    let mut targets: Vec<String> = Vec::new();

    for arg in env::args().skip(1) {
        if arg == "--" {
            break;
        }
        if arg.starts_with('-') && arg.len() > 1 {
            for ch in arg[1..].chars() {
                match ch {
                    'r' | 'R' => opts.recursive = true,
                    'f' => opts.force = true,
                    _ => {
                        eprintln!("rm: invalid option -- '{}'", ch);
                        process::exit(1);
                    }
                }
            }
        } else {
            targets.push(arg);
        }
    }

    if targets.is_empty() {
        if opts.force {
            // rm -f with no args is a silent no-op (matches GNU behavior)
            process::exit(0);
        }
        eprintln!("rm: missing operand");
        process::exit(1);
    }

    let mut exit_code = 0;

    for target in &targets {
        let path = Path::new(target);
        if let Err(e) = remove_path(path, &opts) {
            eprintln!("rm: {}", e);
            exit_code = 1;
        }
    }

    process::exit(exit_code);
}
