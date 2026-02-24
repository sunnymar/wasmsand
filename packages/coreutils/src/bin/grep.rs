//! grep - search for patterns in files

use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::Path;
use std::process;

struct Options {
    ignore_case: bool,
    invert: bool,
    count_only: bool,
    line_numbers: bool,
    files_with_matches: bool,
    recursive: bool,
}

fn matches(line: &str, pattern: &str, ignore_case: bool) -> bool {
    if ignore_case {
        let line_lower = line.to_lowercase();
        let pat_lower = pattern.to_lowercase();
        line_lower.contains(&pat_lower)
    } else {
        line.contains(pattern)
    }
}

fn grep_reader<R: io::Read>(
    reader: R,
    pattern: &str,
    opts: &Options,
    filename: &str,
    show_filename: bool,
) -> io::Result<bool> {
    let buf = BufReader::new(reader);
    let mut match_count: usize = 0;
    let mut found = false;

    for (i, line_result) in buf.lines().enumerate() {
        let line = line_result?;
        let is_match = matches(&line, pattern, opts.ignore_case);
        let selected = if opts.invert { !is_match } else { is_match };

        if selected {
            found = true;

            if opts.files_with_matches {
                // For -l, just print the filename once and stop
                println!("{}", filename);
                return Ok(true);
            }

            if opts.count_only {
                match_count += 1;
                continue;
            }

            let mut prefix = String::new();
            if show_filename {
                prefix.push_str(filename);
                prefix.push(':');
            }
            if opts.line_numbers {
                prefix.push_str(&format!("{}:", i + 1));
            }
            println!("{}{}", prefix, line);
        }
    }

    if opts.count_only {
        if show_filename {
            println!("{}:{}", filename, match_count);
        } else {
            println!("{}", match_count);
        }
    }

    Ok(found)
}

fn grep_path(path: &Path, pattern: &str, opts: &Options, show_filename: bool) -> io::Result<bool> {
    if path.is_dir() {
        if !opts.recursive {
            eprintln!("grep: {}: Is a directory", path.display());
            return Ok(false);
        }
        let mut found = false;
        let mut entries: Vec<_> = fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child = entry.path();
            // Always show filenames when recursing
            match grep_path(&child, pattern, opts, true) {
                Ok(f) => {
                    if f {
                        found = true;
                    }
                }
                Err(e) => {
                    eprintln!("grep: {}: {}", child.display(), e);
                }
            }
        }
        Ok(found)
    } else {
        let f = File::open(path)?;
        grep_reader(f, pattern, opts, &path.display().to_string(), show_filename)
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut opts = Options {
        ignore_case: false,
        invert: false,
        count_only: false,
        line_numbers: false,
        files_with_matches: false,
        recursive: false,
    };
    let mut positional: Vec<String> = Vec::new();
    let mut past_flags = false;

    for arg in &args[1..] {
        if past_flags {
            positional.push(arg.clone());
            continue;
        }
        if arg == "--" {
            past_flags = true;
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'i' => opts.ignore_case = true,
                    'v' => opts.invert = true,
                    'c' => opts.count_only = true,
                    'n' => opts.line_numbers = true,
                    'l' => opts.files_with_matches = true,
                    'r' | 'R' => opts.recursive = true,
                    _ => {
                        eprintln!("grep: invalid option -- '{}'", ch);
                        process::exit(2);
                    }
                }
            }
        } else {
            positional.push(arg.clone());
        }
    }

    if positional.is_empty() {
        eprintln!("grep: missing pattern");
        eprintln!("Usage: grep [OPTION]... PATTERN [FILE]...");
        process::exit(2);
    }

    let pattern = &positional[0];
    let files = &positional[1..];

    let mut found_any = false;
    let mut had_error = false;

    if files.is_empty() {
        // Read from stdin
        let stdin = io::stdin();
        match grep_reader(stdin.lock(), pattern, &opts, "(standard input)", false) {
            Ok(found) => {
                if found {
                    found_any = true;
                }
            }
            Err(e) => {
                eprintln!("grep: (standard input): {}", e);
                had_error = true;
            }
        }
    } else {
        let show_filename = files.len() > 1 || opts.recursive;
        for file in files {
            let path = Path::new(file);
            match grep_path(path, pattern, &opts, show_filename) {
                Ok(found) => {
                    if found {
                        found_any = true;
                    }
                }
                Err(e) => {
                    eprintln!("grep: {}: {}", file, e);
                    had_error = true;
                }
            }
        }
    }

    if had_error {
        process::exit(2);
    } else if found_any {
        process::exit(0);
    } else {
        process::exit(1);
    }
}
