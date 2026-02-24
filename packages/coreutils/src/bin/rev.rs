//! rev - reverse lines of a file or stdin

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::process;

fn rev_reader<R: Read>(reader: R) {
    let buf = BufReader::new(reader);
    for line in buf.lines() {
        match line {
            Ok(l) => {
                let reversed: String = l.chars().rev().collect();
                println!("{}", reversed);
            }
            Err(e) => {
                eprintln!("rev: {}", e);
                process::exit(1);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!("Usage: rev [FILE...]");
        println!("Reverse each line of input.");
        return;
    }

    let files: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();

    if files.is_empty() {
        rev_reader(io::stdin().lock());
    } else {
        for path in &files {
            match File::open(path) {
                Ok(f) => rev_reader(f),
                Err(e) => {
                    eprintln!("rev: {}: {}", path, e);
                    process::exit(1);
                }
            }
        }
    }
}
