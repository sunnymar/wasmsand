use std::env;
use std::fs;
use std::path::Path;
use std::process;

fn main() {
    let mut create_parents = false;
    let mut dirs: Vec<String> = Vec::new();

    let mut skip_next = false;
    for arg in env::args().skip(1) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            break;
        }
        if arg == "-m" || arg == "--mode" {
            skip_next = true; // skip the mode argument (WASM can't set perms)
            continue;
        }
        if let Some(_mode) = arg.strip_prefix("-m") {
            continue; // -mMODE form
        }
        if let Some(_mode) = arg.strip_prefix("--mode=") {
            continue; // --mode=MODE form
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'p' => create_parents = true,
                    'v' => {} // verbose: accept silently
                    _ => {
                        eprintln!("mkdir: invalid option -- '{ch}'");
                        process::exit(1);
                    }
                }
            }
        } else {
            dirs.push(arg);
        }
    }

    if dirs.is_empty() {
        eprintln!("mkdir: missing operand");
        process::exit(1);
    }

    let mut exit_code = 0;

    for dir in &dirs {
        let path = Path::new(dir);
        let result = if create_parents {
            fs::create_dir_all(path)
        } else {
            fs::create_dir(path)
        };

        if let Err(e) = result {
            eprintln!("mkdir: cannot create directory '{}': {}", dir, e);
            exit_code = 1;
        }
    }

    process::exit(exit_code);
}
