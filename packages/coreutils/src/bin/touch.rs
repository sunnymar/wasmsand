//! touch - create empty files or update timestamps

use std::env;
use std::fs::OpenOptions;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut no_create = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 1;

    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-c" | "--no-create" => no_create = true,
            // Accept -d DATE and -t STAMP but ignore the values (WASI limitation)
            "-d" | "--date" | "-t" => {
                i += 1; // skip the date/stamp argument
            }
            "-r" | "--reference" => {
                i += 1; // skip the reference file argument
            }
            "-a" | "-m" => {} // access-time-only / modification-time-only: accept silently
            "--" => {
                i += 1;
                while i < args.len() {
                    files.push(args[i].clone());
                    i += 1;
                }
                break;
            }
            _ if arg.starts_with('-') && arg.len() > 1 => {
                // Accept combined short flags like -cm
                for ch in arg[1..].chars() {
                    match ch {
                        'c' => no_create = true,
                        'a' | 'm' | 'f' => {} // silently accept
                        _ => {
                            eprintln!("touch: invalid option -- '{ch}'");
                            process::exit(1);
                        }
                    }
                }
            }
            _ => files.push(arg.clone()),
        }
        i += 1;
    }

    if files.is_empty() {
        eprintln!("touch: missing file operand");
        process::exit(1);
    }

    let mut exit_code = 0;

    for path in &files {
        if no_create {
            // Only update if file exists
            if std::fs::metadata(path).is_err() {
                continue;
            }
        }
        // Open with create flag - creates if missing, opens if exists.
        // Opening an existing file and immediately closing it updates access time
        // on most systems. For WASI this is the best we can portably do.
        match OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
        {
            Ok(_) => {}
            Err(e) => {
                eprintln!("touch: cannot touch '{path}': {e}");
                exit_code = 1;
            }
        }
    }

    process::exit(exit_code);
}
