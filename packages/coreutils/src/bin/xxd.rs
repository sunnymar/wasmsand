//! xxd - make a hexdump or do the reverse

use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::process;

fn hexdump<R: Read>(reader: &mut R) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut offset: usize = 0;
    let mut buf = [0u8; 16];

    loop {
        let mut total = 0;
        while total < 16 {
            match reader.read(&mut buf[total..]) {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(e) => {
                    eprintln!("xxd: {}", e);
                    process::exit(1);
                }
            }
        }
        if total == 0 {
            break;
        }

        // Offset
        let _ = write!(out, "{:08x}: ", offset);

        // Hex bytes in groups of 2
        for (i, byte) in buf.iter().enumerate() {
            if i < total {
                let _ = write!(out, "{:02x}", byte);
            } else {
                let _ = write!(out, "  ");
            }
            if i % 2 == 1 {
                let _ = write!(out, " ");
            }
        }

        // ASCII representation
        let _ = write!(out, " ");
        for byte in buf.iter().take(total) {
            if (0x20..=0x7e).contains(byte) {
                let _ = write!(out, "{}", *byte as char);
            } else {
                let _ = write!(out, ".");
            }
        }

        let _ = writeln!(out);
        offset += total;
    }
    let _ = out.flush();
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!("Usage: xxd [FILE]");
        println!("Make a hexdump of a file or stdin.");
        return;
    }

    let files: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();

    if files.is_empty() || files[0] == "-" {
        let mut stdin = io::stdin();
        hexdump(&mut stdin);
    } else {
        match File::open(files[0]) {
            Ok(mut f) => hexdump(&mut f),
            Err(e) => {
                eprintln!("xxd: {}: {}", files[0], e);
                process::exit(1);
            }
        }
    }
}
