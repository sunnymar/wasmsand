//! nice - run a program with modified scheduling priority
//!
//! In this sandbox environment the epoch-based nice value is set at sandbox
//! creation time, so this command simply executes the specified program
//! (ignoring the -n adjustment, which has no OS effect inside WASM).

use std::env;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        // No command: print current niceness (always 0 in WASM).
        println!("0");
        return;
    }

    // Parse and skip -n <value> / -n<value> / --adjustment=<value>
    let mut i = 0;
    while i < args.len() {
        if (args[i] == "-n" || args[i] == "--adjustment") && i + 1 < args.len() {
            i += 2;
        } else if args[i].starts_with("-n") || args[i].starts_with("--adjustment=") {
            i += 1;
        } else {
            break;
        }
    }

    if i >= args.len() {
        // Flags only, no command.
        println!("0");
        return;
    }

    // Execute the command with remaining args.
    let cmd = &args[i];
    let cmd_args = &args[i + 1..];
    let status = process::Command::new(cmd)
        .args(cmd_args)
        .status()
        .unwrap_or_else(|e| {
            eprintln!("nice: {cmd}: {e}");
            process::exit(127);
        });
    process::exit(status.code().unwrap_or(1));
}
