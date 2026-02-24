//! sort - sort lines of text

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::process;

fn read_lines_from<R: io::Read>(reader: R) -> io::Result<Vec<String>> {
    let buf = BufReader::new(reader);
    buf.lines().collect()
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut reverse = false;
    let mut numeric = false;
    let mut unique = false;
    let mut files: Vec<String> = Vec::new();

    for arg in &args[1..] {
        if arg == "--" {
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'r' => reverse = true,
                    'n' => numeric = true,
                    'u' => unique = true,
                    _ => {
                        eprintln!("sort: invalid option -- '{}'", ch);
                        process::exit(2);
                    }
                }
            }
        } else {
            files.push(arg.clone());
        }
    }

    // Collect all lines from all inputs
    let mut all_lines: Vec<String> = Vec::new();
    let mut exit_code = 0;

    if files.is_empty() {
        let stdin = io::stdin();
        match read_lines_from(stdin.lock()) {
            Ok(lines) => all_lines.extend(lines),
            Err(e) => {
                eprintln!("sort: {}", e);
                exit_code = 1;
            }
        }
    } else {
        for file in &files {
            if file == "-" {
                let stdin = io::stdin();
                match read_lines_from(stdin.lock()) {
                    Ok(lines) => all_lines.extend(lines),
                    Err(e) => {
                        eprintln!("sort: -: {}", e);
                        exit_code = 1;
                    }
                }
            } else {
                match File::open(file) {
                    Ok(f) => match read_lines_from(f) {
                        Ok(lines) => all_lines.extend(lines),
                        Err(e) => {
                            eprintln!("sort: {}: {}", file, e);
                            exit_code = 1;
                        }
                    },
                    Err(e) => {
                        eprintln!("sort: {}: {}", file, e);
                        exit_code = 2;
                    }
                }
            }
        }
    }

    if exit_code == 2 {
        process::exit(exit_code);
    }

    // Sort the lines
    if numeric {
        all_lines.sort_by(|a, b| {
            let na = parse_numeric_key(a);
            let nb = parse_numeric_key(b);
            let cmp = na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal);
            if reverse {
                cmp.reverse()
            } else {
                cmp
            }
        });
    } else {
        all_lines.sort();
        if reverse {
            all_lines.reverse();
        }
    }

    // Deduplicate if -u
    if unique {
        all_lines.dedup();
    }

    for line in &all_lines {
        println!("{}", line);
    }

    process::exit(exit_code);
}

/// Parse the leading numeric portion of a string for numeric sort.
/// Non-numeric lines compare as 0.
fn parse_numeric_key(s: &str) -> f64 {
    let trimmed = s.trim_start();
    // Try to parse as much of the leading portion as a number
    if trimmed.is_empty() {
        return 0.0;
    }
    // Find the longest prefix that parses as f64
    let mut end = 0;
    let bytes = trimmed.as_bytes();
    // Allow optional leading sign
    if end < bytes.len() && (bytes[end] == b'-' || bytes[end] == b'+') {
        end += 1;
    }
    // Digits before decimal
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    // Optional decimal point
    if end < bytes.len() && bytes[end] == b'.' {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    if end == 0 {
        return 0.0;
    }
    trimmed[..end].parse::<f64>().unwrap_or(0.0)
}
