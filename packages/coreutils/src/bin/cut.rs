//! cut - remove sections from each line of files

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::process;

/// Parse a field/character specification like "1,3-5,7" into a sorted list of
/// 1-based indices.
fn parse_ranges(spec: &str) -> Vec<usize> {
    let mut indices = Vec::new();

    for part in spec.split(',') {
        let part = part.trim();
        if let Some(dash_pos) = part.find('-') {
            let start_str = &part[..dash_pos];
            let end_str = &part[dash_pos + 1..];

            let start: usize = if start_str.is_empty() {
                1
            } else {
                match start_str.parse() {
                    Ok(n) => n,
                    Err(_) => {
                        eprintln!("cut: invalid range: {}", part);
                        process::exit(1);
                    }
                }
            };

            let end: usize = if end_str.is_empty() {
                // Open-ended range; we'll cap it per-line
                usize::MAX
            } else {
                match end_str.parse() {
                    Ok(n) => n,
                    Err(_) => {
                        eprintln!("cut: invalid range: {}", part);
                        process::exit(1);
                    }
                }
            };

            if start == 0 {
                eprintln!("cut: fields and positions are numbered from 1");
                process::exit(1);
            }

            // Cap to a reasonable max to avoid huge allocations
            let capped_end = end.min(100_000);
            for i in start..=capped_end {
                indices.push(i);
            }
        } else {
            match part.parse::<usize>() {
                Ok(0) => {
                    eprintln!("cut: fields and positions are numbered from 1");
                    process::exit(1);
                }
                Ok(n) => indices.push(n),
                Err(_) => {
                    eprintln!("cut: invalid field specification: {}", part);
                    process::exit(1);
                }
            }
        }
    }

    indices.sort();
    indices.dedup();
    indices
}

enum Mode {
    Fields(Vec<usize>),
    Characters(Vec<usize>),
}

fn process_line(line: &str, mode: &Mode, delimiter: char, output_delim: &str) {
    match mode {
        Mode::Fields(ref indices) => {
            let fields: Vec<&str> = line.split(delimiter).collect();
            let mut first = true;
            for &idx in indices {
                if idx <= fields.len() {
                    if !first {
                        print!("{}", output_delim);
                    }
                    print!("{}", fields[idx - 1]);
                    first = false;
                }
            }
            println!();
        }
        Mode::Characters(ref indices) => {
            let chars: Vec<char> = line.chars().collect();
            for &idx in indices {
                if idx <= chars.len() {
                    print!("{}", chars[idx - 1]);
                }
            }
            println!();
        }
    }
}

fn process_reader<R: BufRead>(reader: R, mode: &Mode, delimiter: char, output_delim: &str) {
    for line_result in reader.lines() {
        match line_result {
            Ok(line) => process_line(&line, mode, delimiter, output_delim),
            Err(e) => {
                eprintln!("cut: read error: {}", e);
                process::exit(1);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut delimiter = '\t';
    let mut mode: Option<Mode> = None;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        if args[i] == "-d" {
            i += 1;
            if i >= args.len() {
                eprintln!("cut: option requires an argument -- 'd'");
                process::exit(1);
            }
            let d: Vec<char> = args[i].chars().collect();
            if d.is_empty() {
                eprintln!("cut: delimiter must be a single character");
                process::exit(1);
            }
            delimiter = d[0];
        } else if args[i].starts_with("-d") {
            // Attached form: -d: or -d,
            let d: Vec<char> = args[i][2..].chars().collect();
            if d.is_empty() {
                eprintln!("cut: delimiter must be a single character");
                process::exit(1);
            }
            delimiter = d[0];
        } else if args[i] == "-f" {
            i += 1;
            if i >= args.len() {
                eprintln!("cut: option requires an argument -- 'f'");
                process::exit(1);
            }
            mode = Some(Mode::Fields(parse_ranges(&args[i])));
        } else if args[i].starts_with("-f") {
            let spec = &args[i][2..];
            mode = Some(Mode::Fields(parse_ranges(spec)));
        } else if args[i] == "-c" {
            i += 1;
            if i >= args.len() {
                eprintln!("cut: option requires an argument -- 'c'");
                process::exit(1);
            }
            mode = Some(Mode::Characters(parse_ranges(&args[i])));
        } else if args[i].starts_with("-c") {
            let spec = &args[i][2..];
            mode = Some(Mode::Characters(parse_ranges(spec)));
        } else if args[i] == "--" {
            files.extend_from_slice(&args[i + 1..]);
            break;
        } else {
            files.push(args[i].clone());
        }
        i += 1;
    }

    let mode = match mode {
        Some(m) => m,
        None => {
            eprintln!("cut: you must specify a list of bytes, characters, or fields");
            process::exit(1);
        }
    };

    let output_delim = delimiter.to_string();

    if files.is_empty() || (files.len() == 1 && files[0] == "-") {
        let stdin = io::stdin();
        process_reader(stdin.lock(), &mode, delimiter, &output_delim);
    } else {
        for path in &files {
            if path == "-" {
                let stdin = io::stdin();
                process_reader(stdin.lock(), &mode, delimiter, &output_delim);
            } else {
                match File::open(path) {
                    Ok(f) => process_reader(BufReader::new(f), &mode, delimiter, &output_delim),
                    Err(e) => {
                        eprintln!("cut: {}: {}", path, e);
                        process::exit(1);
                    }
                }
            }
        }
    }
}
