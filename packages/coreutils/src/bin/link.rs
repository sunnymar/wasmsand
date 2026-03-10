use std::{env, fs, process};
fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("link: missing operand");
        process::exit(1);
    }
    if let Err(e) = fs::hard_link(&args[1], &args[2]) {
        eprintln!(
            "link: cannot create link '{}' to '{}': {}",
            args[2], args[1], e
        );
        process::exit(1);
    }
}
