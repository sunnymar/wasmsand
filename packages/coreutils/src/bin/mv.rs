use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

fn copy_and_remove(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        copy_dir_recursive(src, dst)?;
        fs::remove_dir_all(src).map_err(|e| format!("cannot remove '{}': {}", src.display(), e))?;
    } else {
        fs::copy(src, dst).map_err(|e| {
            format!(
                "cannot copy '{}' to '{}': {}",
                src.display(),
                dst.display(),
                e
            )
        })?;
        fs::remove_file(src).map_err(|e| format!("cannot remove '{}': {}", src.display(), e))?;
    }
    Ok(())
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
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "cannot copy '{}' to '{}': {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn move_path(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!(
            "cannot stat '{}': No such file or directory",
            src.display()
        ));
    }

    // Try rename first (fast path for same filesystem)
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            // rename failed (possibly cross-filesystem), fall back to copy + remove
            copy_and_remove(src, dst)
        }
    }
}

fn main() {
    let mut args: Vec<String> = Vec::new();

    for arg in env::args().skip(1) {
        if arg == "--" {
            break;
        }
        if arg.starts_with('-') && arg.len() > 1 {
            // mv has no commonly needed flags for basic use; reject unknown ones
            if let Some(ch) = arg[1..].chars().next() {
                eprintln!("mv: invalid option -- '{}'", ch);
                process::exit(1);
            }
        } else {
            args.push(arg);
        }
    }

    if args.len() < 2 {
        if args.is_empty() {
            eprintln!("mv: missing file operand");
        } else {
            eprintln!("mv: missing destination file operand after '{}'", args[0]);
        }
        process::exit(1);
    }

    let dst_arg = args.last().unwrap().clone();
    let sources = &args[..args.len() - 1];
    let dst = Path::new(&dst_arg);

    let mut exit_code = 0;

    if sources.len() > 1 {
        // Multiple sources: destination must be an existing directory
        if !dst.is_dir() {
            eprintln!("mv: target '{}' is not a directory", dst_arg);
            process::exit(1);
        }
        for src_arg in sources {
            let src = Path::new(src_arg);
            let target = dst.join(
                src.file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new(src_arg)),
            );
            if let Err(e) = move_path(src, &target) {
                eprintln!("mv: {}", e);
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
        if let Err(e) = move_path(src, &target) {
            eprintln!("mv: {}", e);
            exit_code = 1;
        }
    }

    process::exit(exit_code);
}
