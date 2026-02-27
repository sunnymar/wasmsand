//! uniq - report or omit repeated lines

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::process;

struct Options {
    count: bool,
    only_duplicates: bool,
    only_unique: bool,
    ignore_case: bool,
    skip_fields: usize,
    skip_chars: usize,
}

fn read_lines<R: io::Read>(reader: R) -> io::Result<Vec<String>> {
    let buf = BufReader::new(reader);
    buf.lines().collect()
}

/// Extract the comparison key from a line, skipping fields and chars as specified.
fn compare_key<'a>(line: &'a str, opts: &Options) -> &'a str {
    let mut s = line;
    // Skip fields: a field is separated by whitespace
    for _ in 0..opts.skip_fields {
        // Skip leading whitespace then non-whitespace
        s = s.trim_start();
        match s.find(char::is_whitespace) {
            Some(pos) => s = &s[pos..],
            None => return "",
        }
    }
    // Skip chars
    if opts.skip_chars > 0 {
        let char_count = s.chars().count();
        if opts.skip_chars >= char_count {
            return "";
        }
        let byte_offset: usize = s.chars().take(opts.skip_chars).map(|c| c.len_utf8()).sum();
        s = &s[byte_offset..];
    }
    s
}

fn lines_equal(a: &str, b: &str, opts: &Options) -> bool {
    let ka = compare_key(a, opts);
    let kb = compare_key(b, opts);
    if opts.ignore_case {
        ka.eq_ignore_ascii_case(kb)
    } else {
        ka == kb
    }
}

fn process_lines(lines: &[String], opts: &Options) {
    if lines.is_empty() {
        return;
    }

    // Group adjacent identical lines
    let mut groups: Vec<(usize, &str)> = Vec::new();
    let mut current = &lines[0] as &str;
    let mut count: usize = 1;

    for line in &lines[1..] {
        if lines_equal(line, current, opts) {
            count += 1;
        } else {
            groups.push((count, current));
            current = line;
            count = 1;
        }
    }
    groups.push((count, current));

    for (cnt, line) in &groups {
        let is_dup = *cnt > 1;
        // -d: only print duplicated lines
        if opts.only_duplicates && !is_dup {
            continue;
        }
        // -u: only print unique lines (that appeared exactly once)
        if opts.only_unique && is_dup {
            continue;
        }

        if opts.count {
            println!("{:>7} {}", cnt, line);
        } else {
            println!("{}", line);
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut opts = Options {
        count: false,
        only_duplicates: false,
        only_unique: false,
        ignore_case: false,
        skip_fields: 0,
        skip_chars: 0,
    };
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            i += 1;
            continue;
        }
        // -f N (skip fields) and -s N (skip chars) take a value
        if arg == "-f" {
            i += 1;
            if i < args.len() {
                opts.skip_fields = args[i].parse().unwrap_or(0);
            }
            i += 1;
            continue;
        }
        if arg == "-s" {
            i += 1;
            if i < args.len() {
                opts.skip_chars = args[i].parse().unwrap_or(0);
            }
            i += 1;
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'c' => opts.count = true,
                    'd' => opts.only_duplicates = true,
                    'u' => opts.only_unique = true,
                    'i' => opts.ignore_case = true,
                    _ => {
                        eprintln!("uniq: invalid option -- '{}'", ch);
                        process::exit(1);
                    }
                }
            }
        } else {
            files.push(arg.clone());
        }
        i += 1;
    }

    let lines = if files.is_empty() || files[0] == "-" {
        let stdin = io::stdin();
        match read_lines(stdin.lock()) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("uniq: {}", e);
                process::exit(1);
            }
        }
    } else {
        match File::open(&files[0]) {
            Ok(f) => match read_lines(f) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("uniq: {}: {}", files[0], e);
                    process::exit(1);
                }
            },
            Err(e) => {
                eprintln!("uniq: {}: {}", files[0], e);
                process::exit(1);
            }
        }
    };

    process_lines(&lines, &opts);
}
