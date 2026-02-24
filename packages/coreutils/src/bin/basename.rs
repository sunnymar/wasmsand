//! basename - strip directory and suffix from filenames

use std::env;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("basename: missing operand");
        process::exit(1);
    }

    let path = &args[1];
    let suffix = if args.len() > 2 {
        Some(args[2].as_str())
    } else {
        None
    };

    // Remove trailing slashes
    let trimmed = path.trim_end_matches('/');

    // If the entire string was slashes, result is "/"
    if trimmed.is_empty() {
        println!("/");
        return;
    }

    // Find the last component
    let base = match trimmed.rfind('/') {
        Some(pos) => &trimmed[pos + 1..],
        None => trimmed,
    };

    // Strip suffix if provided and if the name is longer than the suffix
    let result = if let Some(sfx) = suffix {
        if !sfx.is_empty() && base.len() > sfx.len() && base.ends_with(sfx) {
            &base[..base.len() - sfx.len()]
        } else {
            base
        }
    } else {
        base
    };

    println!("{}", result);
}
