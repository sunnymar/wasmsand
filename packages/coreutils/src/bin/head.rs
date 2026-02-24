//! head - output the first part of files

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::process;

fn head_reader<R: BufRead>(reader: R, count: usize, stdout: &mut impl Write) -> io::Result<()> {
    for (i, line) in reader.lines().enumerate() {
        if i >= count {
            break;
        }
        let line = line?;
        writeln!(stdout, "{}", line)?;
    }
    Ok(())
}

fn print_usage() {
    eprintln!("Usage: head [-n NUM] [FILE]...");
    eprintln!("Print the first NUM lines of each FILE to standard output.");
    eprintln!("With no FILE, or when FILE is -, read standard input.");
    eprintln!("NUM defaults to 10.");
}

fn run() -> i32 {
    let args: Vec<String> = env::args().collect();
    let mut count: usize = 10;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-n" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("head: option requires an argument -- 'n'");
                    return 1;
                }
                match args[i].parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("head: invalid number of lines: '{}'", args[i]);
                        return 1;
                    }
                }
            }
            "--lines" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("head: option '--lines' requires an argument");
                    return 1;
                }
                match args[i].parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("head: invalid number of lines: '{}'", args[i]);
                        return 1;
                    }
                }
            }
            arg if arg.starts_with("--lines=") => {
                let val = &arg["--lines=".len()..];
                match val.parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("head: invalid number of lines: '{}'", val);
                        return 1;
                    }
                }
            }
            arg if arg.starts_with("-")
                && arg.len() > 1
                && arg[1..].chars().all(|c| c.is_ascii_digit()) =>
            {
                // Handle -NUM shorthand (e.g., -5)
                match arg[1..].parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("head: invalid number of lines: '{}'", &arg[1..]);
                        return 1;
                    }
                }
            }
            "--help" => {
                print_usage();
                return 0;
            }
            "--" => {
                i += 1;
                while i < args.len() {
                    files.push(args[i].clone());
                    i += 1;
                }
                break;
            }
            arg if arg.starts_with('-') && arg.len() > 1 => {
                eprintln!("head: invalid option -- '{}'", &arg[1..]);
                return 1;
            }
            _ => files.push(args[i].clone()),
        }
        i += 1;
    }

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let mut exit_code = 0;
    let multiple = files.len() > 1;

    if files.is_empty() {
        files.push("-".to_string());
    }

    for (idx, file) in files.iter().enumerate() {
        if multiple {
            if idx > 0 {
                let _ = writeln!(stdout);
            }
            let name = if file == "-" {
                "standard input"
            } else {
                file.as_str()
            };
            let _ = writeln!(stdout, "==> {} <==", name);
        }

        if file == "-" {
            let stdin = io::stdin();
            let reader = BufReader::new(stdin.lock());
            if let Err(e) = head_reader(reader, count, &mut stdout) {
                eprintln!("head: standard input: {}", e);
                exit_code = 1;
            }
        } else {
            match File::open(file) {
                Ok(f) => {
                    let reader = BufReader::new(f);
                    if let Err(e) = head_reader(reader, count, &mut stdout) {
                        eprintln!("head: {}: {}", file, e);
                        exit_code = 1;
                    }
                }
                Err(e) => {
                    eprintln!("head: cannot open '{}' for reading: {}", file, e);
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
