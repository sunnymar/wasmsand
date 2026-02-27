//! tail - output the last part of files

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process;

fn tail_bytes<R: Read>(mut reader: R, count: usize, stdout: &mut impl Write) -> io::Result<()> {
    if count == 0 {
        return Ok(());
    }
    let mut all = Vec::new();
    reader.read_to_end(&mut all)?;
    let start = if all.len() > count {
        all.len() - count
    } else {
        0
    };
    stdout.write_all(&all[start..])?;
    Ok(())
}

fn tail_reader<R: BufRead>(reader: R, count: usize, stdout: &mut impl Write) -> io::Result<()> {
    if count == 0 {
        return Ok(());
    }

    // Use a ring buffer to keep the last `count` lines in memory
    let mut ring: Vec<String> = Vec::with_capacity(count);
    let mut pos: usize = 0;
    let mut total: usize = 0;

    for line in reader.lines() {
        let line = line?;
        if ring.len() < count {
            ring.push(line);
        } else {
            ring[pos] = line;
        }
        pos = (pos + 1) % count;
        total += 1;
    }

    // Output the lines in order
    let stored = ring.len();
    let start = if total <= count { 0 } else { pos };
    for i in 0..stored {
        let idx = (start + i) % stored;
        writeln!(stdout, "{}", ring[idx])?;
    }

    Ok(())
}

fn print_usage() {
    eprintln!("Usage: tail [-n NUM] [FILE]...");
    eprintln!("Print the last NUM lines of each FILE to standard output.");
    eprintln!("With no FILE, or when FILE is -, read standard input.");
    eprintln!("NUM defaults to 10.");
}

fn run() -> i32 {
    let args: Vec<String> = env::args().collect();
    let mut count: usize = 10;
    let mut byte_mode = false;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-c" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("tail: option requires an argument -- 'c'");
                    return 1;
                }
                match args[i].parse::<usize>() {
                    Ok(n) => {
                        count = n;
                        byte_mode = true;
                    }
                    Err(_) => {
                        eprintln!("tail: invalid number of bytes: '{}'", args[i]);
                        return 1;
                    }
                }
            }
            "-n" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("tail: option requires an argument -- 'n'");
                    return 1;
                }
                let val = &args[i];
                // Support +NUM syntax (lines from beginning) - simplified: treat as count
                let parse_val = if let Some(stripped) = val.strip_prefix('+') {
                    stripped
                } else {
                    val.as_str()
                };
                match parse_val.parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("tail: invalid number of lines: '{}'", args[i]);
                        return 1;
                    }
                }
            }
            "--lines" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("tail: option '--lines' requires an argument");
                    return 1;
                }
                match args[i].parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("tail: invalid number of lines: '{}'", args[i]);
                        return 1;
                    }
                }
            }
            arg if arg.starts_with("--lines=") => {
                let val = &arg["--lines=".len()..];
                match val.parse::<usize>() {
                    Ok(n) => count = n,
                    Err(_) => {
                        eprintln!("tail: invalid number of lines: '{}'", val);
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
                        eprintln!("tail: invalid number of lines: '{}'", &arg[1..]);
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
                eprintln!("tail: invalid option -- '{}'", &arg[1..]);
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
            let result = if byte_mode {
                tail_bytes(stdin.lock(), count, &mut stdout)
            } else {
                tail_reader(BufReader::new(stdin.lock()), count, &mut stdout)
            };
            if let Err(e) = result {
                eprintln!("tail: standard input: {}", e);
                exit_code = 1;
            }
        } else {
            match File::open(file) {
                Ok(f) => {
                    let result = if byte_mode {
                        tail_bytes(f, count, &mut stdout)
                    } else {
                        tail_reader(BufReader::new(f), count, &mut stdout)
                    };
                    if let Err(e) = result {
                        eprintln!("tail: {}: {}", file, e);
                        exit_code = 1;
                    }
                }
                Err(e) => {
                    eprintln!("tail: cannot open '{}' for reading: {}", file, e);
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
