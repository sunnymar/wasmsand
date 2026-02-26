//! csplit - split a file into sections determined by context lines

use regex::Regex;
use std::env;
use std::fs;
use std::io::Write;
use std::process;

enum Pattern {
    Regex { pattern: String, skip: bool },
    Repeat { count: usize },
}

fn matches_line(pattern: &str, line: &str) -> bool {
    match Regex::new(pattern) {
        Ok(re) => re.is_match(line),
        Err(_) => false,
    }
}

fn parse_patterns(args: &[String]) -> Vec<Pattern> {
    let mut patterns = Vec::new();

    for arg in args {
        if arg.starts_with('/') && arg.ends_with('/') && arg.len() > 1 {
            let inner = &arg[1..arg.len() - 1];
            patterns.push(Pattern::Regex {
                pattern: inner.to_string(),
                skip: false,
            });
        } else if arg.starts_with('%') && arg.ends_with('%') && arg.len() > 1 {
            let inner = &arg[1..arg.len() - 1];
            patterns.push(Pattern::Regex {
                pattern: inner.to_string(),
                skip: true,
            });
        } else if arg.starts_with('{') && arg.ends_with('}') {
            let inner = &arg[1..arg.len() - 1];
            match inner.parse::<usize>() {
                Ok(n) => patterns.push(Pattern::Repeat { count: n }),
                Err(_) => {
                    eprintln!("csplit: invalid repeat count: {arg}");
                    process::exit(1);
                }
            }
        } else {
            match arg.parse::<usize>() {
                Ok(_n) => {
                    patterns.push(Pattern::Regex {
                        pattern: arg.clone(),
                        skip: false,
                    });
                }
                Err(_) => {
                    eprintln!("csplit: invalid pattern: {arg}");
                    process::exit(1);
                }
            }
        }
    }

    patterns
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.iter().any(|a| a == "--help") {
        println!("Usage: csplit [OPTIONS] FILE PATTERN...");
        println!("Split FILE into sections determined by PATTERN(s).");
        println!("  -f PREFIX  Use PREFIX instead of 'xx'");
        println!("  /REGEX/    Split at lines matching REGEX");
        println!("  %REGEX%    Skip to line matching REGEX");
        println!("  {{N}}        Repeat previous pattern N times");
        return;
    }

    let mut prefix = String::from("xx");
    let mut positional: Vec<String> = Vec::new();
    let mut i = 1;

    while i < args.len() {
        if args[i] == "-f" {
            i += 1;
            if i >= args.len() {
                eprintln!("csplit: option requires an argument -- 'f'");
                process::exit(1);
            }
            prefix = args[i].clone();
        } else {
            positional.push(args[i].clone());
        }
        i += 1;
    }

    if positional.len() < 2 {
        eprintln!("csplit: usage: csplit [OPTIONS] FILE PATTERN...");
        process::exit(1);
    }

    let file = &positional[0];
    let content = match fs::read_to_string(file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("csplit: {file}: {e}");
            process::exit(1);
        }
    };

    let lines: Vec<&str> = content.lines().collect();
    let patterns = parse_patterns(&positional[1..]);

    // Expand repeat patterns
    let mut expanded: Vec<&Pattern> = Vec::new();
    for (i, pat) in patterns.iter().enumerate() {
        match pat {
            Pattern::Repeat { count } => {
                if i == 0 {
                    eprintln!("csplit: repeat count with no preceding pattern");
                    process::exit(1);
                }
                for _ in 0..*count {
                    expanded.push(&patterns[i - 1]);
                }
            }
            other => expanded.push(other),
        }
    }

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut file_index = 0;
    let mut line_idx = 0;

    for pat in &expanded {
        match pat {
            Pattern::Regex { pattern, skip } => {
                let found = lines
                    .iter()
                    .enumerate()
                    .skip(line_idx)
                    .find(|(_, line)| matches_line(pattern, line))
                    .map(|(i, _)| i);

                let split_at = match found {
                    Some(pos) => pos,
                    None => lines.len(),
                };

                if *skip {
                    line_idx = split_at;
                } else {
                    let section: String = lines[line_idx..split_at]
                        .iter()
                        .map(|l| format!("{l}\n"))
                        .collect();
                    let filename = format!("{prefix}{file_index:02}");
                    if let Err(e) = fs::write(&filename, &section) {
                        eprintln!("csplit: {filename}: {e}");
                        process::exit(1);
                    }
                    let _ = writeln!(out, "{}", section.len());
                    file_index += 1;
                    line_idx = split_at;
                }
            }
            Pattern::Repeat { .. } => unreachable!(),
        }
    }

    // Write remaining lines
    if line_idx < lines.len() {
        let section: String = lines[line_idx..].iter().map(|l| format!("{l}\n")).collect();
        let filename = format!("{prefix}{file_index:02}");
        if let Err(e) = fs::write(&filename, &section) {
            eprintln!("csplit: {filename}: {e}");
            process::exit(1);
        }
        let _ = writeln!(out, "{}", section.len());
    } else {
        let filename = format!("{prefix}{file_index:02}");
        if let Err(e) = fs::write(&filename, "") {
            eprintln!("csplit: {filename}: {e}");
            process::exit(1);
        }
        let _ = writeln!(out, "0");
    }
}
