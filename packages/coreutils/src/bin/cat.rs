//! cat - concatenate and print files

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::process;

fn cat_reader<R: BufRead>(
    reader: R,
    number_lines: bool,
    stdout: &mut impl Write,
) -> io::Result<()> {
    if number_lines {
        for (i, line) in reader.lines().enumerate() {
            let line = line?;
            writeln!(stdout, "{:>6}\t{}", i + 1, line)?;
        }
    } else {
        // Use raw byte copying for efficiency when not numbering lines
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
    let mut number_lines = false;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-n" => number_lines = true,
            "--number" => number_lines = true,
            "--" => {
                i += 1;
                while i < args.len() {
                    files.push(args[i].clone());
                    i += 1;
                }
                break;
            }
            arg if arg.starts_with('-') && arg.len() > 1 => {
                // Handle combined short flags like -n
                let chars: Vec<char> = arg[1..].chars().collect();
                for c in chars {
                    match c {
                        'n' => number_lines = true,
                        _ => {
                            eprintln!("cat: invalid option -- '{}'", c);
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

    if files.is_empty() || files.iter().any(|f| f == "-") {
        // If no files, read from stdin. If "-" appears among files, read stdin at that position.
        if files.is_empty() {
            let stdin = io::stdin();
            let reader = BufReader::new(stdin.lock());
            if let Err(e) = cat_reader(reader, number_lines, &mut stdout) {
                eprintln!("cat: stdin: {}", e);
                exit_code = 1;
            }
        } else {
            for file in &files {
                if file == "-" {
                    let stdin = io::stdin();
                    let reader = BufReader::new(stdin.lock());
                    if let Err(e) = cat_reader(reader, number_lines, &mut stdout) {
                        eprintln!("cat: stdin: {}", e);
                        exit_code = 1;
                    }
                } else {
                    match File::open(file) {
                        Ok(f) => {
                            let reader = BufReader::new(f);
                            if let Err(e) = cat_reader(reader, number_lines, &mut stdout) {
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
                    if let Err(e) = cat_reader(reader, number_lines, &mut stdout) {
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
