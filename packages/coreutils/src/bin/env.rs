//! env - print environment variables

use std::env;

fn main() {
    // If no arguments (beyond program name), print all environment variables.
    // In a full implementation with args we would modify the environment and
    // exec a command, but under WASI exec is not available, so we just print.
    let args: Vec<String> = env::args().collect();

    if args.len() <= 1 {
        // Print all environment variables
        for (key, value) in env::vars() {
            println!("{}={}", key, value);
        }
    } else {
        // With arguments: set KEY=VALUE pairs, print remaining env.
        // We parse KEY=VALUE arguments and update the process environment,
        // then print everything (since we cannot exec under WASI).
        let mut i = 1;
        let mut modified = false;

        while i < args.len() {
            if let Some(eq_pos) = args[i].find('=') {
                let key = &args[i][..eq_pos];
                let value = &args[i][eq_pos + 1..];
                env::set_var(key, value);
                modified = true;
            } else {
                // Not a KEY=VALUE pair; treat as command name.
                // Under WASI we cannot exec, so just warn and print env.
                if modified {
                    eprintln!(
                        "env: cannot execute '{}': not supported under WASI",
                        args[i]
                    );
                }
                break;
            }
            i += 1;
        }

        for (key, value) in env::vars() {
            println!("{}={}", key, value);
        }
    }
}
