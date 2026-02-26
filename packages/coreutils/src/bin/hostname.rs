//! hostname - print the system hostname

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!("Usage: hostname [-f]");
        println!("Print the system hostname.");
        return;
    }
    if args.iter().any(|a| a == "-f") {
        println!("codepod.local");
    } else {
        println!("codepod");
    }
}
