//! sort - sort lines of text

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::process;

fn read_lines_from<R: io::Read>(reader: R) -> io::Result<Vec<String>> {
    let buf = BufReader::new(reader);
    buf.lines().collect()
}

/// Extract the sort key from a line based on -t separator and -k field number.
fn extract_key(line: &str, separator: Option<char>, key_field: Option<usize>) -> &str {
    let field = match key_field {
        Some(k) => k,
        None => return line,
    };
    // 1-based field index
    if field == 0 {
        return line;
    }
    let parts: Vec<&str> = match separator {
        Some(sep) => line.split(sep).collect(),
        None => line.split_whitespace().collect(),
    };
    if field <= parts.len() {
        parts[field - 1]
    } else {
        ""
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut reverse = false;
    let mut numeric = false;
    let mut unique = false;
    let mut fold_case = false;
    let mut ignore_blanks = false;
    let mut separator: Option<char> = None;
    let mut key_field: Option<usize> = None;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            i += 1;
            // Remaining args are files
            while i < args.len() {
                files.push(args[i].clone());
                i += 1;
            }
            break;
        }
        if arg.starts_with("-t") && arg.len() > 2 {
            // -tX form (separator attached)
            separator = arg[2..].chars().next();
        } else if arg == "-t" {
            // -t X form (separator as next arg)
            i += 1;
            if i < args.len() {
                separator = args[i].chars().next();
            }
        } else if arg.starts_with("-k") && arg.len() > 2 {
            // -kN form (key attached)
            // Parse just the field number (ignore .pos if present)
            let spec = &arg[2..];
            let field_str = spec
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .unwrap_or("");
            key_field = field_str.parse().ok();
        } else if arg == "-k" {
            // -k N form (key as next arg)
            i += 1;
            if i < args.len() {
                let spec = &args[i];
                let field_str = spec
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .unwrap_or("");
                key_field = field_str.parse().ok();
            }
        } else if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'r' => reverse = true,
                    'n' => numeric = true,
                    'u' => unique = true,
                    'f' => fold_case = true,
                    'b' => ignore_blanks = true,
                    _ => {
                        eprintln!("sort: invalid option -- '{}'", ch);
                        process::exit(2);
                    }
                }
            }
        } else {
            files.push(arg.clone());
        }
        i += 1;
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
    all_lines.sort_by(|a, b| {
        let mut ka = extract_key(a, separator, key_field);
        let mut kb = extract_key(b, separator, key_field);
        // Owned strings for transformations
        let ka_owned: String;
        let kb_owned: String;
        if ignore_blanks {
            ka_owned = ka.trim_start().to_string();
            kb_owned = kb.trim_start().to_string();
            ka = &ka_owned;
            kb = &kb_owned;
        }
        let cmp = if numeric {
            let na = parse_numeric_key(ka);
            let nb = parse_numeric_key(kb);
            na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
        } else if fold_case {
            ka.to_lowercase().cmp(&kb.to_lowercase())
        } else {
            ka.cmp(kb)
        };
        if reverse {
            cmp.reverse()
        } else {
            cmp
        }
    });

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
    if trimmed.is_empty() {
        return 0.0;
    }
    let mut end = 0;
    let bytes = trimmed.as_bytes();
    if end < bytes.len() && (bytes[end] == b'-' || bytes[end] == b'+') {
        end += 1;
    }
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
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
