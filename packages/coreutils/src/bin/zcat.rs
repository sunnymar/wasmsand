//! zcat - decompress gzip files to stdout
//!
//! Equivalent to `gzip -dc`.

use flate2::read::GzDecoder;
use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::process;

fn decompress<R: Read>(reader: R, name: &str) -> io::Result<()> {
    let mut decoder = GzDecoder::new(reader);
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut buf = [0u8; 65536];
    loop {
        let n = decoder.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
    }
    let _ = name;
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: zcat file.gz [...]");
        process::exit(1);
    }
    let mut status = 0i32;
    for path in &args[1..] {
        let result = if path == "-" {
            decompress(io::stdin(), "<stdin>")
        } else {
            File::open(path)
                .and_then(|f| decompress(f, path))
        };
        if let Err(e) = result {
            eprintln!("zcat: {}: {}", path, e);
            status = 1;
        }
    }
    process::exit(status);
}
