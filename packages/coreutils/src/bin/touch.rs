//! touch - create empty files or update timestamps

use std::env;
use std::fs::OpenOptions;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("touch: missing file operand");
        process::exit(1);
    }

    let mut exit_code = 0;

    for path in &args[1..] {
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
                eprintln!("touch: cannot touch '{}': {}", path, e);
                exit_code = 1;
            }
        }
    }

    process::exit(exit_code);
}
