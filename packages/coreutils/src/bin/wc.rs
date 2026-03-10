//! wc - word, line, and byte count

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::process;

struct Counts {
    lines: usize,
    words: usize,
    bytes: usize,
    chars: usize,
    max_line_len: usize,
}

impl Counts {
    fn new() -> Self {
        Counts {
            lines: 0,
            words: 0,
            bytes: 0,
            chars: 0,
            max_line_len: 0,
        }
    }

    fn add(&mut self, other: &Counts) {
        self.lines += other.lines;
        self.words += other.words;
        self.bytes += other.bytes;
        self.chars += other.chars;
        if other.max_line_len > self.max_line_len {
            self.max_line_len = other.max_line_len;
        }
    }
}

fn count_reader<R: Read>(reader: R) -> io::Result<Counts> {
    let mut counts = Counts::new();
    let mut buf = BufReader::new(reader);
    let mut line_buf = String::new();

    loop {
        line_buf.clear();
        let n = buf.read_line(&mut line_buf)?;
        if n == 0 {
            break;
        }
        // read_line preserves the trailing newline if present
        let has_newline = line_buf.ends_with('\n');
        let content = if has_newline {
            &line_buf[..line_buf.len() - 1]
        } else {
            &line_buf[..]
        };

        counts.lines += if has_newline { 1 } else { 0 };
        counts.bytes += n;
        counts.chars += content.chars().count() + if has_newline { 1 } else { 0 };
        counts.words += content.split_whitespace().count();
        if content.len() > counts.max_line_len {
            counts.max_line_len = content.len();
        }
    }
    Ok(counts)
}

fn print_counts(
    counts: &Counts,
    show_lines: bool,
    show_words: bool,
    show_bytes: bool,
    show_chars: bool,
    show_max_line_len: bool,
    name: &str,
) {
    let mut parts: Vec<String> = Vec::new();
    if show_lines {
        parts.push(format!("{:>8}", counts.lines));
    }
    if show_words {
        parts.push(format!("{:>8}", counts.words));
    }
    if show_chars {
        parts.push(format!("{:>8}", counts.chars));
    }
    if show_bytes {
        parts.push(format!("{:>8}", counts.bytes));
    }
    if show_max_line_len {
        parts.push(format!("{:>8}", counts.max_line_len));
    }
    let line = parts.join("");
    if name.is_empty() {
        println!("{}", line);
    } else {
        println!("{} {}", line, name);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut show_lines = false;
    let mut show_words = false;
    let mut show_bytes = false;
    let mut show_chars = false;
    let mut show_max_line_len = false;
    let mut files: Vec<String> = Vec::new();

    for arg in &args[1..] {
        if arg == "--" {
            // Everything after -- is a filename
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'l' => show_lines = true,
                    'w' => show_words = true,
                    'c' => show_bytes = true,
                    'm' => show_chars = true,
                    'L' => show_max_line_len = true,
                    _ => {
                        eprintln!("wc: invalid option -- '{}'", ch);
                        process::exit(1);
                    }
                }
            }
        } else {
            files.push(arg.clone());
        }
    }

    // If no specific flag is set, show all three (but not -L)
    if !show_lines && !show_words && !show_bytes && !show_chars && !show_max_line_len {
        show_lines = true;
        show_words = true;
        show_bytes = true;
    }

    let mut exit_code = 0;

    if files.is_empty() {
        // Read from stdin
        let stdin = io::stdin();
        match count_reader(stdin.lock()) {
            Ok(counts) => print_counts(
                &counts,
                show_lines,
                show_words,
                show_bytes,
                show_chars,
                show_max_line_len,
                "",
            ),
            Err(e) => {
                eprintln!("wc: {}", e);
                exit_code = 1;
            }
        }
    } else {
        let mut total = Counts::new();
        for file in &files {
            match File::open(file) {
                Ok(f) => match count_reader(f) {
                    Ok(counts) => {
                        print_counts(
                            &counts,
                            show_lines,
                            show_words,
                            show_bytes,
                            show_chars,
                            show_max_line_len,
                            file,
                        );
                        total.add(&counts);
                    }
                    Err(e) => {
                        eprintln!("wc: {}: {}", file, e);
                        exit_code = 1;
                    }
                },
                Err(e) => {
                    eprintln!("wc: {}: {}", file, e);
                    exit_code = 1;
                }
            }
        }
        if files.len() > 1 {
            print_counts(
                &total,
                show_lines,
                show_words,
                show_bytes,
                show_chars,
                show_max_line_len,
                "total",
            );
        }
    }

    process::exit(exit_code);
}
