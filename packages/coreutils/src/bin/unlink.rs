use std::{env, fs, process};
fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 2 {
        eprintln!("unlink: missing operand");
        process::exit(1);
    }
    if let Err(e) = fs::remove_file(&args[1]) {
        eprintln!("unlink: cannot unlink '{}': {}", args[1], e);
        process::exit(1);
    }
}
