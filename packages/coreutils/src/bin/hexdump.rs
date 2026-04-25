//! hexdump - display file contents in hexadecimal, decimal, octal, or ascii
//!
//! Supports basic -C (canonical hex+ASCII) format.

use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::process;

fn dump_canonical<R: Read>(reader: &mut R, name: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut offset: u64 = 0;
    let mut buf = [0u8; 16];

    loop {
        let mut total = 0;
        while total < 16 {
            match reader.read(&mut buf[total..]) {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(e) => {
                    eprintln!("hexdump: {}: {}", name, e);
                    process::exit(1);
                }
            }
        }
        if total == 0 {
            break;
        }

        let _ = write!(out, "{:08x}  ", offset);

        for i in 0..16 {
            if i < total {
                let _ = write!(out, "{:02x} ", buf[i]);
            } else {
                let _ = write!(out, "   ");
            }
            if i == 7 {
                let _ = write!(out, " ");
            }
        }

        let _ = write!(out, " |");
        for byte in buf.iter().take(total) {
            if (0x20..=0x7e).contains(byte) {
                let _ = write!(out, "{}", *byte as char);
            } else {
                let _ = write!(out, ".");
            }
        }
        let _ = writeln!(out, "|");
        offset += total as u64;
    }
    let _ = writeln!(out, "{:08x}", offset);
    let _ = out.flush();
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut canonical = false;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-C" => canonical = true,
            "--help" => {
                println!("Usage: hexdump [-C] [FILE...]");
                return;
            }
            f => files.push(f.to_string()),
        }
        i += 1;
    }

    // Default to canonical if no format specified (like `hexdump -C`)
    let _ = canonical;

    if files.is_empty() {
        let mut stdin = io::stdin();
        dump_canonical(&mut stdin, "<stdin>");
    } else {
        for path in &files {
            match File::open(path) {
                Ok(mut f) => dump_canonical(&mut f, path),
                Err(e) => {
                    eprintln!("hexdump: {}: {}", path, e);
                    process::exit(1);
                }
            }
        }
    }
}
