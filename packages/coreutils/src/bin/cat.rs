//! cat - concatenate and print files

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::process;

struct CatOptions {
    number_lines: bool,
    number_nonblank: bool,
    squeeze_blank: bool,
    show_ends: bool,
}

fn cat_reader<R: BufRead>(
    reader: R,
    opts: &CatOptions,
    line_num: &mut usize,
    stdout: &mut impl Write,
) -> io::Result<()> {
    if opts.number_lines || opts.number_nonblank || opts.squeeze_blank || opts.show_ends {
        let mut prev_blank = false;
        for line_result in reader.lines() {
            let line = line_result?;
            let is_blank = line.trim().is_empty();

            if opts.squeeze_blank && is_blank && prev_blank {
                continue;
            }
            prev_blank = is_blank;

            let suffix = if opts.show_ends { "$" } else { "" };

            if opts.number_nonblank {
                if is_blank {
                    writeln!(stdout, "{suffix}")?;
                } else {
                    *line_num += 1;
                    writeln!(stdout, "{:>6}\t{line}{suffix}", *line_num)?;
                }
            } else if opts.number_lines {
                *line_num += 1;
                writeln!(stdout, "{:>6}\t{line}{suffix}", *line_num)?;
            } else {
                writeln!(stdout, "{line}{suffix}")?;
            }
        }
    } else {
        // Use raw byte copying for efficiency when not using any options
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            stdout.write_all(&buf[..n])?;
        }
    }
    Ok(())
}

fn run() -> i32 {
    let args: Vec<String> = env::args().collect();
    let mut opts = CatOptions {
        number_lines: false,
        number_nonblank: false,
        squeeze_blank: false,
        show_ends: false,
    };
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-n" | "--number" => opts.number_lines = true,
            "-b" | "--number-nonblank" => opts.number_nonblank = true,
            "-s" | "--squeeze-blank" => opts.squeeze_blank = true,
            "-E" | "--show-ends" => opts.show_ends = true,
            "-A" | "--show-all" => opts.show_ends = true, // simplified: just show ends
            "--" => {
                i += 1;
                while i < args.len() {
                    files.push(args[i].clone());
                    i += 1;
                }
                break;
            }
            arg if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") => {
                for c in arg[1..].chars() {
                    match c {
                        'n' => opts.number_lines = true,
                        'b' => opts.number_nonblank = true,
                        's' => opts.squeeze_blank = true,
                        'E' => opts.show_ends = true,
                        'e' => opts.show_ends = true, // -e implies -E
                        'A' => opts.show_ends = true,
                        'T' | 't' | 'v' => {} // accept silently
                        _ => {
                            eprintln!("cat: invalid option -- '{c}'");
                            return 1;
                        }
                    }
                }
            }
            _ => files.push(args[i].clone()),
        }
        i += 1;
    }

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let mut exit_code = 0;
    let mut line_num: usize = 0;

    if files.is_empty() || files.iter().any(|f| f == "-") {
        // If no files, read from stdin. If "-" appears among files, read stdin at that position.
        if files.is_empty() {
            let stdin = io::stdin();
            let reader = BufReader::new(stdin.lock());
            if let Err(e) = cat_reader(reader, &opts, &mut line_num, &mut stdout) {
                eprintln!("cat: stdin: {}", e);
                exit_code = 1;
            }
        } else {
            for file in &files {
                if file == "-" {
                    let stdin = io::stdin();
                    let reader = BufReader::new(stdin.lock());
                    if let Err(e) = cat_reader(reader, &opts, &mut line_num, &mut stdout) {
                        eprintln!("cat: stdin: {}", e);
                        exit_code = 1;
                    }
                } else {
                    match File::open(file) {
                        Ok(f) => {
                            let reader = BufReader::new(f);
                            if let Err(e) = cat_reader(reader, &opts, &mut line_num, &mut stdout) {
                                eprintln!("cat: {}: {}", file, e);
                                exit_code = 1;
                            }
                        }
                        Err(e) => {
                            eprintln!("cat: {}: {}", file, e);
                            exit_code = 1;
                        }
                    }
                }
            }
        }
    } else {
        for file in &files {
            match File::open(file) {
                Ok(f) => {
                    let reader = BufReader::new(f);
                    if let Err(e) = cat_reader(reader, &opts, &mut line_num, &mut stdout) {
                        eprintln!("cat: {}: {}", file, e);
                        exit_code = 1;
                    }
                }
                Err(e) => {
                    eprintln!("cat: {}: {}", file, e);
                    exit_code = 1;
                }
            }
        }
    }

    exit_code
}

fn main() {
    process::exit(run());
}
