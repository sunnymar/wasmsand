use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

struct Options {
    recursive: bool,
}

fn copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    fs::copy(src, dst).map(|_| ()).map_err(|e| {
        format!(
            "cannot copy '{}' to '{}': {}",
            src.display(),
            dst.display(),
            e
        )
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir(dst)
            .map_err(|e| format!("cannot create directory '{}': {}", dst.display(), e))?;
    }

    let entries = fs::read_dir(src)
        .map_err(|e| format!("cannot read directory '{}': {}", src.display(), e))?;

    for entry in entries {
        let entry =
            entry.map_err(|e| format!("error reading entry in '{}': {}", src.display(), e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            copy_file(&src_path, &dst_path)?;
        }
    }

    Ok(())
}

fn copy_source(src: &Path, dst: &Path, opts: &Options) -> Result<(), String> {
    if !src.exists() {
        return Err(format!(
            "cannot stat '{}': No such file or directory",
            src.display()
        ));
    }

    if src.is_dir() {
        if !opts.recursive {
            return Err(format!(
                "omitting directory '{}' (use -r to copy recursively)",
                src.display()
            ));
        }
        copy_dir_recursive(src, dst)
    } else {
        copy_file(src, dst)
    }
}

fn main() {
    let mut opts = Options { recursive: false };
    let mut args: Vec<String> = Vec::new();

    for arg in env::args().skip(1) {
        if arg == "--" {
            break;
        }
        if arg.starts_with('-') && arg.len() > 1 {
            for ch in arg[1..].chars() {
                match ch {
                    'r' | 'R' => opts.recursive = true,
                    _ => {
                        eprintln!("cp: invalid option -- '{}'", ch);
                        process::exit(1);
                    }
                }
            }
        } else {
            args.push(arg);
        }
    }

    if args.len() < 2 {
        eprintln!("cp: missing operand");
        process::exit(1);
    }

    let dst_arg = args.last().unwrap().clone();
    let sources = &args[..args.len() - 1];
    let dst = Path::new(&dst_arg);

    let mut exit_code = 0;

    if sources.len() > 1 {
        // Multiple sources: destination must be an existing directory
        if !dst.is_dir() {
            eprintln!("cp: target '{}' is not a directory", dst_arg);
            process::exit(1);
        }
        for src_arg in sources {
            let src = Path::new(src_arg);
            let target = dst.join(
                src.file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new(src_arg)),
            );
            if let Err(e) = copy_source(src, &target, &opts) {
                eprintln!("cp: {}", e);
                exit_code = 1;
            }
        }
    } else {
        // Single source
        let src = Path::new(&sources[0]);
        let target: PathBuf = if dst.is_dir() {
            dst.join(
                src.file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new(&sources[0])),
            )
        } else {
            dst.to_path_buf()
        };
        if let Err(e) = copy_source(src, &target, &opts) {
            eprintln!("cp: {}", e);
            exit_code = 1;
        }
    }

    process::exit(exit_code);
}
