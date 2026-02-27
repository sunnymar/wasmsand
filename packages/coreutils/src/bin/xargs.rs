use std::env;
use std::io::{self, BufRead, BufWriter, Read, Write};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // Parse flags
    let mut max_args: Option<usize> = None;
    let mut replace_token: Option<String> = None;
    let mut null_delim = false;
    let mut cmd_start = 0;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-n" && i + 1 < args.len() {
            max_args = args[i + 1].parse().ok();
            i += 2;
            cmd_start = i;
        } else if args[i] == "-0" {
            null_delim = true;
            i += 1;
            cmd_start = i;
        } else if args[i] == "-I" && i + 1 < args.len() {
            // Separate form: -I {}
            replace_token = Some(args[i + 1].clone());
            i += 2;
            cmd_start = i;
        } else if args[i].starts_with("-I") && args[i].len() > 2 {
            // Attached form: -I{}
            replace_token = Some(args[i][2..].to_string());
            i += 1;
            cmd_start = i;
        } else {
            break;
        }
    }

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // Command prefix (args after flags, or empty for default echo behavior)
    let cmd_parts: Vec<&str> = if cmd_start < args.len() {
        args[cmd_start..].iter().map(|s| s.as_str()).collect()
    } else {
        vec![]
    };

    if let Some(ref token) = replace_token {
        // -I mode: read lines, replace token in command template, output
        let stdin = io::stdin();
        for line_result in stdin.lock().lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => break,
            };
            let line = line.trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            let replaced: Vec<String> = cmd_parts
                .iter()
                .map(|part| part.replace(token.as_str(), &line))
                .collect();
            let _ = writeln!(out, "{}", replaced.join(" "));
        }
    } else {
        // Read all stdin, split on whitespace or null bytes (-0)
        let mut input = String::new();
        io::stdin().read_to_string(&mut input).unwrap_or(0);

        let items: Vec<&str> = if null_delim {
            input.split('\0').filter(|s| !s.is_empty()).collect()
        } else {
            input.split_whitespace().collect()
        };
        if items.is_empty() {
            return;
        }

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
}
