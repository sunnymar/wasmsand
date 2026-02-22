use std::env;
use std::io::{self, Read, Write, BufWriter};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Parse flags
    let mut max_args: Option<usize> = None;
    let mut cmd_start = 0;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-n" && i + 1 < args.len() {
            max_args = args[i + 1].parse().ok();
            i += 2;
            cmd_start = i;
        } else {
            break;
        }
    }

    // Read all stdin
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or(0);

    let items: Vec<&str> = input.split_whitespace().collect();
    if items.is_empty() { return; }

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // Command prefix (args after flags, or empty for default echo behavior)
    let cmd_parts: Vec<&str> = if cmd_start < args.len() {
        args[cmd_start..].iter().map(|s| s.as_str()).collect()
    } else {
        vec![]
    };

    match max_args {
        Some(n) => {
            for chunk in items.chunks(n) {
                if !cmd_parts.is_empty() {
                    let _ = write!(out, "{}", cmd_parts.join(" "));
                    if !chunk.is_empty() {
                        let _ = write!(out, " ");
                    }
                }
                let _ = writeln!(out, "{}", chunk.join(" "));
            }
        }
        None => {
            if !cmd_parts.is_empty() {
                let _ = write!(out, "{} ", cmd_parts.join(" "));
            }
            let _ = writeln!(out, "{}", items.join(" "));
        }
    }
}
